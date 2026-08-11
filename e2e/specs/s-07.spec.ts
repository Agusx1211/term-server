import { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test, type IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultController, NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalEvent,
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
import LoginPage from "../pages/login-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;
const TRANSCRIPT_TIMEOUT_MS = 45_000;
const ITERATIONS = 300;
const MAX_VISIBLE_PANES = 4;
const CACHE_LIMIT = 8;
const MOUNT_WINDOW = MAX_VISIBLE_PANES + CACHE_LIMIT;
const BASELINE_ITERATION = 12;
const SAMPLE_INTERVAL = 25;
const MAX_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;
const MAX_TIMER_GROWTH = 256;
const MAX_LISTENER_GROWTH = 256;
const MAX_CANVAS_GROWTH = 4;
const MAX_RSS_MULTIPLIER = 4;

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
  __TERM_SERVER_E2E_RENDERER_RESOURCES__?: {
    isWebGLCanvas(canvas: HTMLCanvasElement): boolean;
  };
  __TERM_SERVER_E2E_RESOURCE_COUNTERS__?: {
    read(): { readonly timerCount: number; readonly listenerCount: number };
  };
}

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly pid: number | null;
  readonly status: string;
  readonly clients?: number;
}

interface FixtureTerminal {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly pid: number;
  readonly readyId: string;
  readonly printId: string;
  readonly printText: string;
  readonly printLine: string;
}

interface BrowserResourceSample {
  readonly mountedPaneCount: number;
  readonly visiblePaneCount: number;
  readonly cachedPaneCount: number;
  readonly domPaneCount: number;
  readonly socketCount: number;
  readonly rendererCount: number;
  readonly diagnosticWebglContextCount: number;
  readonly canvasCount: number;
  readonly attachedCanvasCount: number;
  readonly canvasPixels: number;
  readonly canvasPaneIds: readonly string[];
  readonly canvasDimensions: readonly { readonly width: number; readonly height: number }[];
  readonly mountedIds: readonly string[];
  readonly heapUsedBytes?: number;
  readonly heapAvailable: boolean;
  readonly timerCount?: number;
  readonly listenerCount?: number;
}

interface ProcessResourceSample {
  readonly processCount: number;
  readonly rssBytes: number;
  readonly fixtureCount: number;
  readonly brokerCount: number;
  readonly serverCount: number;
}

interface ResourceSample {
  readonly iteration: number | "final";
  readonly terminalCount: number;
  readonly browser: BrowserResourceSample;
  readonly process: ProcessResourceSample;
  readonly proxySocketCount: number;
}

interface ProcRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly commandLine: string;
}

function safeMarker(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function cssAttribute(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

function printLine(id: string, text: string): string {
  return `[E2E:PRINT:${id}:${text}]`;
}

async function readTerminalListing(page: Page): Promise<TerminalApiInfo[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error("terminal listing response was not an array");
    return value as TerminalApiInfo[];
  });
}

async function waitForNewTerminalEvent(
  page: Page,
  knownIds: readonly string[],
  eventType: "mount" | "synced",
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ known, type, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => (
      event.type === type
      && event.snapshot.kind === "pane"
      && !known.includes(event.terminalId)
    ), { timeout });
  }, { known: [...knownIds], type: eventType, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  marker: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.lifecycle.mounted
      && snapshot.lifecycle.visible
      && snapshot.lifecycle.active
      && snapshot.lifecycle.focused
      && snapshot.lifecycle.acceptingInput
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.renderCount > 0
      && snapshot.xterm.text.includes(expected)
    ), { timeout });
  }, { id: terminalId, expected: marker, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCachedTerminal(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === "visibility"
      && event.data.visible === false
      && event.snapshot.lifecycle.mounted
      && event.snapshot.lifecycle.cached
      && !event.snapshot.lifecycle.active
      && !event.snapshot.lifecycle.focused
      && !event.snapshot.lifecycle.acceptingInput
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function readVisibleTerminalIds(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals()
      .filter((snapshot) => snapshot.kind === "pane" && snapshot.lifecycle.visible)
      .map((snapshot) => snapshot.terminalId);
  });
}

async function readActiveTerminalId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const active = api.terminals().find((snapshot) => snapshot.kind === "pane" && snapshot.lifecycle.active);
    if (!active) throw new Error("cache churn has no active terminal");
    return active.terminalId;
  });
}

async function readBrowserResourceSample(page: Page): Promise<BrowserResourceSample> {
  return page.evaluate(() => {
    const target = window as E2EWindow;
    const api = target.__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const snapshots = api.terminals().filter((snapshot) => snapshot.kind === "pane" && snapshot.lifecycle.mounted);
    const tracker = target.__TERM_SERVER_E2E_RENDERER_RESOURCES__;
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>("main.editor-grid .xterm-host canvas")];
    const slots = [...document.querySelectorAll("main.editor-grid .pane-slot")];
    const canvasPaneIds = [...new Set(canvases.map((canvas) => canvas.closest<HTMLElement>("[data-terminal-id]")?.dataset.terminalId).filter((id): id is string => Boolean(id)))];
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: unknown } }).memory;
    const heapUsedBytes = typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
      ? memory.usedJSHeapSize
      : undefined;
    const counters = target.__TERM_SERVER_E2E_RESOURCE_COUNTERS__?.read();
    return {
      mountedPaneCount: snapshots.length,
      visiblePaneCount: snapshots.filter((snapshot) => snapshot.lifecycle.visible).length,
      cachedPaneCount: snapshots.filter((snapshot) => snapshot.lifecycle.cached).length,
      domPaneCount: slots.length,
      socketCount: snapshots.reduce((total, snapshot) => total + snapshot.activeSocketCount, 0),
      rendererCount: snapshots.filter((snapshot) => snapshot.rendererState.kind === snapshot.renderer).length,
      diagnosticWebglContextCount: snapshots.filter((snapshot) => snapshot.renderer === "webgl").length,
      canvasCount: canvases.length,
      attachedCanvasCount: canvases.filter((canvas) => canvas.isConnected).length,
      canvasPixels: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
      canvasPaneIds,
      canvasDimensions: canvases.map((canvas) => ({ width: canvas.width, height: canvas.height })),
      mountedIds: snapshots.map((snapshot) => snapshot.terminalId),
      heapUsedBytes,
      heapAvailable: heapUsedBytes !== undefined,
      timerCount: counters?.timerCount,
      listenerCount: counters?.listenerCount,
    };
  });
}

async function readProcRecord(pid: number): Promise<ProcRecord | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
    if (parent === undefined) return undefined;
    const rssKb = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
    let commandLine = "";
    try {
      commandLine = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").replaceAll("\0", " ").trim();
    } catch {
      commandLine = "";
    }
    return {
      pid,
      ppid: Number(parent),
      rssBytes: Number(rssKb ?? 0) * 1024,
      commandLine,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readProcessResourceSample(server: IsolatedServer): Promise<ProcessResourceSample> {
  if (process.platform !== "linux") throw new Error("S-07 process resource sampling requires Linux /proc");
  if (server.pid === undefined) throw new Error("isolated server PID is unavailable for S-07 resource sampling");
  const entries = await readdir("/proc", { withFileTypes: true });
  const processIds = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name));
  const records = (await Promise.all(processIds.map((pid) => readProcRecord(pid)))).filter((record): record is ProcRecord => Boolean(record));
  const byParent = new Map<number, number[]>();
  for (const record of records) {
    const children = byParent.get(record.ppid);
    if (children) children.push(record.pid);
    else byParent.set(record.ppid, [record.pid]);
  }
  const selected = new Set<number>([server.pid]);
  const pending = [server.pid];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const child of byParent.get(parent) ?? []) {
      if (selected.has(child)) continue;
      selected.add(child);
      pending.push(child);
    }
  }
  const tree = records.filter((record) => selected.has(record.pid));
  if (!tree.some((record) => record.pid === server.pid)) throw new Error("isolated server disappeared during S-07 process sampling");
  return {
    processCount: tree.length,
    rssBytes: tree.reduce((total, record) => total + record.rssBytes, 0),
    fixtureCount: tree.filter((record) => record.commandLine.includes("e2e-pty-fixture")).length,
    brokerCount: tree.filter((record) => record.commandLine.includes("--session-broker")).length,
    serverCount: tree.filter((record) => record.pid === server.pid).length,
  };
}

function connectionKey(event: NetworkFaultEvent): string | undefined {
  if (event.connectionId !== undefined) return `connection:${event.connectionId}`;
  if (event.terminalId !== undefined && event.generation !== undefined) return `terminal:${event.terminalId}:${event.generation}`;
  return undefined;
}

function countLiveProxySockets(events: readonly NetworkFaultEvent[]): number {
  const live = new Map<string, boolean>();
  for (const event of events) {
    const key = connectionKey(event);
    if (!key) continue;
    if (event.type === "connection-open") live.set(key, true);
    else if (event.type === "connection-closed" || event.type === "connection-terminated") live.set(key, false);
  }
  return [...live.values()].filter(Boolean).length;
}

async function readResourceSample(
  page: Page,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  iteration: number | "final",
): Promise<ResourceSample> {
  const [listing, browser, processResources] = await Promise.all([
    readTerminalListing(page),
    readBrowserResourceSample(page),
    readProcessResourceSample(server),
  ]);
  return {
    iteration,
    terminalCount: listing.length,
    browser,
    process: processResources,
    proxySocketCount: countLiveProxySockets(faultController.events),
  };
}

function assertTerminalViewport(snapshot: E2ETerminalSnapshot, phase: string): void {
  expect(snapshot.serverViewport, `${phase}: server viewport was not selected`).toBeDefined();
  expect(snapshot.serverViewport?.cols, `${phase}: server columns diverged`).toBe(snapshot.cols);
  expect(snapshot.serverViewport?.rows, `${phase}: server rows diverged`).toBe(snapshot.rows);
  expect(snapshot.viewport.cols, `${phase}: viewport columns diverged`).toBe(snapshot.cols);
  expect(snapshot.viewport.rows, `${phase}: viewport rows diverged`).toBe(snapshot.rows);
}

function assertResourceWindow(sample: ResourceSample, activeTerminalCount: number, phase: string): void {
  const expectedVisible = Math.min(MAX_VISIBLE_PANES, activeTerminalCount);
  expect(sample.browser.visiblePaneCount, `${phase}: visible pane count`).toBe(expectedVisible);
  expect(sample.browser.domPaneCount, `${phase}: DOM pane count diverged`).toBe(sample.browser.mountedPaneCount);
  expect(sample.browser.mountedPaneCount, `${phase}: mounted pane count exceeded cache window`).toBeLessThanOrEqual(
    Math.min(MOUNT_WINDOW, activeTerminalCount),
  );
  expect(sample.browser.cachedPaneCount, `${phase}: cached pane count exceeded configured limit`).toBeLessThanOrEqual(CACHE_LIMIT);
  expect(sample.browser.mountedPaneCount, `${phase}: cached plus visible panes disagreed`).toBe(
    sample.browser.visiblePaneCount + sample.browser.cachedPaneCount,
  );
  expect(sample.browser.socketCount, `${phase}: live sockets did not equal mounted panes`).toBe(sample.browser.mountedPaneCount);
  expect(sample.browser.rendererCount, `${phase}: live renderers did not equal mounted panes`).toBe(sample.browser.mountedPaneCount);
  expect(sample.browser.attachedCanvasCount, `${phase}: detached canvas remained attached`).toBe(sample.browser.canvasCount);
  expect(sample.browser.canvasPaneIds.length, `${phase}: canvas owner count diverged`).toBe(
    sample.browser.canvasCount === 0 ? 0 : sample.browser.mountedPaneCount,
  );
  expect(sample.browser.canvasDimensions.every((dimension) => dimension.width >= 0 && dimension.height >= 0)).toBe(true);
  expect(sample.browser.diagnosticWebglContextCount).toBeLessThanOrEqual(sample.browser.rendererCount);
  expect(sample.proxySocketCount, `${phase}: proxy and browser socket counts diverged`).toBe(sample.browser.socketCount);
  expect(sample.process.serverCount).toBe(1);
  expect(sample.process.brokerCount).toBeGreaterThanOrEqual(1);
  expect(sample.process.fixtureCount, `${phase}: fixture process count diverged from server sessions`).toBe(sample.terminalCount);
}

function assertNoGrowth(sample: ResourceSample, baseline: ResourceSample, phase: string): void {
  expect(sample.browser.mountedPaneCount, `${phase}: mounted pane resource leaked`).toBeLessThanOrEqual(MOUNT_WINDOW);
  expect(sample.browser.visiblePaneCount, `${phase}: visible pane resource leaked`).toBeLessThanOrEqual(MAX_VISIBLE_PANES);
  expect(sample.browser.canvasCount, `${phase}: canvas resource grew`).toBeLessThanOrEqual(
    baseline.browser.canvasCount + MAX_CANVAS_GROWTH,
  );
  expect(sample.browser.canvasPixels, `${phase}: canvas backing pixels grew`).toBeLessThanOrEqual(
    baseline.browser.canvasPixels + Math.max(1, baseline.browser.canvasPixels) * 2,
  );
  if (baseline.browser.heapAvailable && sample.browser.heapAvailable) {
    expect(sample.browser.heapUsedBytes! - baseline.browser.heapUsedBytes!, `${phase}: heap exceeded accepted bound`).toBeLessThanOrEqual(MAX_HEAP_GROWTH_BYTES);
  }
  if (baseline.browser.timerCount !== undefined && sample.browser.timerCount !== undefined) {
    expect(sample.browser.timerCount - baseline.browser.timerCount, `${phase}: active timers exceeded accepted bound`).toBeLessThanOrEqual(MAX_TIMER_GROWTH);
  }
  if (baseline.browser.listenerCount !== undefined && sample.browser.listenerCount !== undefined) {
    expect(sample.browser.listenerCount - baseline.browser.listenerCount, `${phase}: listeners exceeded accepted bound`).toBeLessThanOrEqual(MAX_LISTENER_GROWTH);
  }
  const expectedRss = baseline.process.rssBytes
    + Math.max(0, sample.process.fixtureCount - baseline.process.fixtureCount)
      * Math.max(1, Math.floor(baseline.process.rssBytes / Math.max(1, baseline.process.fixtureCount)))
      * MAX_RSS_MULTIPLIER;
  expect(sample.process.rssBytes, `${phase}: process RSS exceeded the session-scaled bound`).toBeLessThanOrEqual(
    expectedRss + MAX_HEAP_GROWTH_BYTES,
  );
}

function assertMonotonicResourceTrend(samples: readonly ResourceSample[], baseline: ResourceSample): void {
  const heap = samples
    .filter((sample) => sample.browser.heapAvailable && sample.browser.heapUsedBytes !== undefined)
    .map((sample) => sample.browser.heapUsedBytes!);
  if (heap.length > 1) {
    let positiveGrowth = 0;
    for (let index = 1; index < heap.length; index += 1) positiveGrowth += Math.max(0, heap[index]! - heap[index - 1]!);
    expect(positiveGrowth, "S-07 heap trend exceeded the accepted bound").toBeLessThanOrEqual(MAX_HEAP_GROWTH_BYTES);
  }
  const timerCounts = samples.map((sample) => sample.browser.timerCount).filter((value): value is number => value !== undefined);
  if (timerCounts.length) expect(Math.max(...timerCounts) - (baseline.browser.timerCount ?? timerCounts[0]!), "S-07 timer trend exceeded the accepted bound").toBeLessThanOrEqual(MAX_TIMER_GROWTH);
  const listenerCounts = samples.map((sample) => sample.browser.listenerCount).filter((value): value is number => value !== undefined);
  if (listenerCounts.length) expect(Math.max(...listenerCounts) - (baseline.browser.listenerCount ?? listenerCounts[0]!), "S-07 listener trend exceeded the accepted bound").toBeLessThanOrEqual(MAX_LISTENER_GROWTH);
}

async function assertEvictedPaneHasNoResources(page: Page, terminalId: string, phase: string): Promise<void> {
  expect(await terminalSnapshot(page, terminalId), `${phase}: evicted pane retained diagnostics`).toBeUndefined();
  expect(await terminalEvents(page, terminalId), `${phase}: evicted pane retained event listeners`).toEqual([]);
  await expect(page.locator(`main.editor-grid [data-terminal-id="${cssAttribute(terminalId)}"]`), `${phase}: evicted pane remained in the DOM`).toHaveCount(0);
}

async function printWithBoundary(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  printId: string,
  printText: string,
): Promise<E2ETerminalSnapshot> {
  const gate = `${printId}-HOLD`;
  const holdWait = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "hold" && entry.token === gate,
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await pane.sendInput(`HOLD ${gate}`, true);
  await holdWait;

  const command = `PRINT ${printId} ${printText}`;
  const commandWait = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === "PRINT"
      && entry.command_base64 === Buffer.from(command, "utf8").toString("base64"),
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  const printWait = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === printId && entry.text === printText,
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  const before = await terminalSnapshot(page, terminalId);
  if (!before) throw new Error(`S-07 ${terminalId}: diagnostics disappeared before PRINT`);
  const rendered = waitForRenderedMarker(page, terminalId, printLine(printId, printText));
  await pane.sendInput(command, true);
  await commandWait;
  const releaseWait = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "release" && entry.token === gate,
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await pane.sendInput(`RELEASE ${gate}`, true);
  await Promise.all([printWait, releaseWait]);
  const renderedSnapshot = await rendered;
  expect(renderedSnapshot.renderCount).toBeGreaterThan(before.renderCount);
  await expectTerminalBuffer(page, terminalId, { contains: printLine(printId, printText), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  return renderedSnapshot;
}

async function createFixtureTerminal(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  knownIds: readonly string[],
  runTag: string,
  index: number,
): Promise<FixtureTerminal> {
  const mountPromise = waitForNewTerminalEvent(page, knownIds, "mount");
  const syncPromise = waitForNewTerminalEvent(page, knownIds, "synced");
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.sidebar.createTerminal();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const created = await response.json() as TerminalApiInfo;
  expect(created.id).not.toBe("");
  expect(created.name).not.toBe("");
  expect(created.path).not.toBe("");
  expect(created.pid).toEqual(expect.any(Number));
  const [mounted, synced] = await Promise.all([mountPromise, syncPromise]);
  expect(mounted.terminalId).toBe(created.id);
  expect(synced.terminalId).toBe(created.id);

  const pane = await workbench.openTerminal({ id: created.id, name: created.name });
  await pane.expectVisible();
  const interactive = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.lifecycle.mounted
      && snapshot.lifecycle.visible
      && snapshot.lifecycle.active
      && snapshot.lifecycle.focused
      && snapshot.lifecycle.acceptingInput
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout });
  }, { id: created.id, timeout: WAIT_TIMEOUT_MS });
  assertNoPendingSynchronization(interactive);
  assertTerminalViewport(interactive, `create ${index}`);

  const readyId = `${runTag}-T${index}-READY`;
  const readyWait = server.waitForTranscript(
    created.id,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await pane.sendInput(`READY ${readyId}`, true);
  await readyWait;
  await expectTerminalBuffer(page, created.id, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  const printId = `${runTag}-T${index}-PRINT`;
  const printText = `${runTag}-T${index}-MARKER`;
  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  await printWithBoundary(page, server, pane, created.id, printId, printText);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    artifactName: `s-07-create-${index}-nonblank`,
  });
  const afterPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforePixels, afterPixels, {
    minimumChangedRatio: 0.002,
    artifactName: `s-07-create-${index}-marker`,
  });
  const snapshot = await terminalSnapshot(page, created.id);
  if (!snapshot) throw new Error(`S-07 create ${index}: diagnostics disappeared after PRINT`);
  expect(snapshot.xterm.text).toContain(printLine(printId, printText));
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.rendererState.kind).toBe(snapshot.renderer);
  assertTerminalViewport(snapshot, `create ${index} after PRINT`);
  return {
    id: created.id,
    name: created.name,
    path: created.path,
    pid: created.pid!,
    readyId,
    printId,
    printText,
    printLine: printLine(printId, printText),
  };
}

async function reopenEvictedAndRemove(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  target: FixtureTerminal,
  activeTerminals: ReadonlyMap<string, FixtureTerminal>,
  iteration: number,
): Promise<readonly string[]> {
  expect(await terminalSnapshot(page, target.id), `iteration ${iteration}: target was not evicted before reopen`).toBeUndefined();
  const beforeMounted = await workbench.terminalPaneIds();
  expect(beforeMounted).not.toContain(target.id);
  const visibleIds = await readVisibleTerminalIds(page);
  const activeId = await readActiveTerminalId(page);
  const activeBefore = activeTerminals.get(activeId);
  if (!activeBefore) throw new Error(`iteration ${iteration}: active terminal is not in the cache model`);
  expect(visibleIds).toContain(activeBefore.id);
  const previousPane = workbench.terminal(activeBefore.id, activeBefore.name);
  await previousPane.expectVisible();
  const beforePixels = await screenshotRegion(page, previousPane.xtermHost);

  const expectedEvicted = beforeMounted.find((id) => !visibleIds.includes(id));
  if (!expectedEvicted) throw new Error(`iteration ${iteration}: cache window had no hidden pane to evict during reopen`);
  const evictedUnmount = waitForTerminalEvent(page, expectedEvicted, "unmount", { timeout: WAIT_TIMEOUT_MS });
  const mountPromise = waitForTerminalEvent(page, target.id, "mount", { timeout: WAIT_TIMEOUT_MS });
  const syncPromise = waitForTerminalEvent(page, target.id, "synced", { timeout: WAIT_TIMEOUT_MS });
  const renderedPromise = waitForRenderedMarker(page, target.id, target.printLine);
  const opened = await workbench.openTerminal({ id: target.id, name: target.name });
  await opened.expectVisible();
  const [mounted, synced, rendered, unmounted] = await Promise.all([
    mountPromise,
    syncPromise,
    renderedPromise,
    evictedUnmount,
  ]);
  expect(mounted.terminalId).toBe(target.id);
  expect(synced.terminalId).toBe(target.id);
  expect(unmounted.terminalId).toBe(expectedEvicted);
  expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
  expect(unmounted.snapshot.activeSocketCount).toBe(0);
  expect(unmounted.snapshot.socket.activeCount).toBe(0);
  await assertEvictedPaneHasNoResources(page, expectedEvicted, `iteration ${iteration} reopen eviction`);
  expect(rendered.lifecycle).toMatchObject({ mounted: true, visible: true, active: true, focused: true, acceptingInput: true });
  expect(rendered.socketState).toBe("connected");
  expect(rendered.activeSocketCount).toBe(1);
  expect(rendered.xterm.text).toContain(target.printLine);
  await expectTerminalBuffer(page, target.id, { contains: target.printLine, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, opened.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    artifactName: `s-07-reopen-${iteration}-nonblank`,
  });
  const afterPixels = await screenshotRegion(page, opened.xtermHost);
  await expectTerminalPixelsChanged(beforePixels, afterPixels, {
    minimumChangedRatio: 0.002,
    artifactName: `s-07-reopen-${iteration}-marker`,
  });
  assertNoPendingSynchronization(rendered);
  assertTerminalViewport(rendered, `iteration ${iteration} reopened`);
  await expectConnectedTerminalInvariants(page, target.id, { timeout: WAIT_TIMEOUT_MS });

  const hiddenPromise = waitForCachedTerminal(page, target.id);
  const returned = await workbench.openTerminal({ id: activeBefore.id, name: activeBefore.name });
  await returned.expectVisible();
  const hidden = await hiddenPromise;
  expect(hidden.snapshot.lifecycle).toMatchObject({ mounted: true, visible: false, cached: true, active: false, focused: false, acceptingInput: false });
  expect(hidden.snapshot.activeSocketCount).toBe(1);
  await expectConnectedTerminalInvariants(page, activeBefore.id, { timeout: WAIT_TIMEOUT_MS });

  const eventsBeforeKill = faultController.events;
  const liveGeneration = [...new Set(eventsBeforeKill
    .filter((event) => event.terminalId === target.id && event.type === "connection-open" && event.generation !== undefined)
    .map((event) => event.generation!))]
    .find((generation) => !eventsBeforeKill.some((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === target.id
      && event.generation === generation
    )));
  const closePromise = liveGeneration === undefined
    ? Promise.resolve<NetworkFaultEvent | undefined>(undefined)
    : faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === target.id
      && event.generation === liveGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
  const targetSnapshot = await terminalSnapshot(page, target.id);
  const unmountPromise = targetSnapshot
    ? waitForTerminalEvent(page, target.id, "unmount", { timeout: WAIT_TIMEOUT_MS })
    : Promise.resolve<E2ETerminalEvent | undefined>(undefined);
  const exitPromise = server.waitForTranscript(
    target.id,
    (entry) => entry.event === "exit",
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  const deleteResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "DELETE" && url.pathname === `/api/terminals/${target.id}`;
  });
  const dialogPromise = new Promise<void>((resolve, reject) => {
    page.once("dialog", (dialog) => {
      try {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toBe(`Kill and remove “${target.path}”? The process and its scrollback will be lost.`);
        void dialog.accept().then(resolve, reject);
      } catch (error) {
        void dialog.dismiss().catch(() => undefined);
        reject(error);
      }
    });
  });
  const row = await workbench.sidebar.terminalRow({ id: target.id, name: target.name });
  await row.getByRole("button", { name: `Kill ${target.name}`, exact: true }).click();
  const response = await deleteResponsePromise;
  expect(response.status()).toBe(204);
  await dialogPromise;
  const [exit, unmountedAfterKill, closed] = await Promise.all([exitPromise, unmountPromise, closePromise]);
  expect(exit.code).toBe(0);
  if (unmountedAfterKill) {
    expect(unmountedAfterKill.snapshot.lifecycle.mounted).toBe(false);
    expect(unmountedAfterKill.snapshot.activeSocketCount).toBe(0);
    expect(unmountedAfterKill.snapshot.socket.activeCount).toBe(0);
  }
  if (liveGeneration !== undefined) expect(closed?.terminalId).toBe(target.id);
  expect(await terminalSnapshot(page, target.id)).toBeUndefined();
  expect(await terminalEvents(page, target.id)).toEqual([]);
  const processResponseStatus = await page.evaluate(async (id) => {
    const response = await fetch(`/api/terminals/${id}/processes`, { cache: "no-store" });
    return response.status;
  }, target.id);
  expect(processResponseStatus).toBe(404);
  const listing = await readTerminalListing(page);
  expect(listing.some((candidate) => candidate.id === target.id)).toBe(false);
  return [expectedEvicted];
}

async function removeTerminalThroughSidebar(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  terminal: FixtureTerminal,
): Promise<void> {
  const snapshot = await terminalSnapshot(page, terminal.id);
  const unmountPromise = snapshot
    ? waitForTerminalEvent(page, terminal.id, "unmount", { timeout: WAIT_TIMEOUT_MS })
    : Promise.resolve<E2ETerminalEvent | undefined>(undefined);
  const exitPromise = server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "exit",
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  const eventsBeforeKill = faultController.events;
  const liveGeneration = [...new Set(eventsBeforeKill
    .filter((event) => event.terminalId === terminal.id && event.type === "connection-open" && event.generation !== undefined)
    .map((event) => event.generation!))]
    .find((generation) => !eventsBeforeKill.some((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminal.id
      && event.generation === generation
    )));
  const closePromise = liveGeneration === undefined
    ? Promise.resolve<NetworkFaultEvent | undefined>(undefined)
    : faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminal.id
      && event.generation === liveGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
  const deleteResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "DELETE" && url.pathname === `/api/terminals/${terminal.id}`;
  });
  const dialogPromise = new Promise<void>((resolve, reject) => {
    page.once("dialog", (dialog) => {
      try {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toBe(`Kill and remove “${terminal.path}”? The process and its scrollback will be lost.`);
        void dialog.accept().then(resolve, reject);
      } catch (error) {
        void dialog.dismiss().catch(() => undefined);
        reject(error);
      }
    });
  });
  const row = await workbench.sidebar.terminalRow({ id: terminal.id, name: terminal.name });
  await row.getByRole("button", { name: `Kill ${terminal.name}`, exact: true }).click();
  const response = await deleteResponsePromise;
  expect(response.status()).toBe(204);
  await dialogPromise;
  const [exit, unmounted, closed] = await Promise.all([exitPromise, unmountPromise, closePromise]);
  expect(exit.code).toBe(0);
  if (unmounted) expect(unmounted.snapshot.activeSocketCount).toBe(0);
  if (liveGeneration !== undefined) expect(closed?.terminalId).toBe(terminal.id);
  expect(await terminalSnapshot(page, terminal.id)).toBeUndefined();
  expect(await terminalEvents(page, terminal.id)).toEqual([]);
  const processResponseStatus = await page.evaluate(async (id) => {
    const response = await fetch(`/api/terminals/${id}/processes`, { cache: "no-store" });
    return response.status;
  }, terminal.id);
  expect(processResponseStatus).toBe(404);
  const listing = await readTerminalListing(page);
  expect(listing.some((candidate) => candidate.id === terminal.id)).toBe(false);
}

async function exerciseContinuedInput(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminal: FixtureTerminal,
  runTag: string,
  testInfo: TestInfo,
): Promise<void> {
  const echoId = `${runTag}-CONTINUED-ECHO`;
  const echoText = `${runTag}-CONTINUED-INPUT`;
  const armed = server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await armed;
  const payload = server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(echoText, "utf8").toString("base64"),
    { timeoutMs: TRANSCRIPT_TIMEOUT_MS },
  );
  const before = await terminalSnapshot(page, terminal.id);
  if (!before) throw new Error("S-07 continued-input diagnostics disappeared");
  const marker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;
  const rendered = waitForRenderedMarker(page, terminal.id, marker);
  await pane.sendInput(echoText, true);
  const entry = await payload;
  expect(entry.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminal.id, { contains: marker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await rendered;
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "s-07-continued-input",
  });
  const after = await terminalSnapshot(page, terminal.id);
  if (!after) throw new Error("S-07 continued-input diagnostics disappeared after echo");
  expect(after.renderCount).toBeGreaterThan(before.renderCount);
  expect(after.acceptingInput).toBe(true);
  assertNoPendingSynchronization(after);
  const report = await expectConnectedTerminalInvariants(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
  expect(report.violations).toEqual([]);
  await assertMonotonicSequences(report.events);
}

async function assertTranscriptHistory(
  server: IsolatedServer,
  terminal: FixtureTerminal,
  expectExit: boolean,
): Promise<void> {
  const transcript = await server.readTranscript(terminal.id);
  expect(transcript.filter((entry) => entry.event === "error"), `${terminal.id}: fixture reported an error`).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === terminal.readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === terminal.printId && entry.text === terminal.printText)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "command" && entry.operation === "PRINT" && entry.command_base64 === Buffer.from(`PRINT ${terminal.printId} ${terminal.printText}`, "utf8").toString("base64"))).toHaveLength(1);
  if (expectExit) expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(1);
}

function assertNoUnexpectedProxyFaults(events: readonly NetworkFaultEvent[]): void {
  const unexpected = events.filter((event) => [
    "socket-error",
    "malformed-frame",
    "paused",
    "resumed",
    "throttled",
    "dropped",
    "restored",
    "injected",
  ].includes(event.type));
  expect(unexpected).toEqual([]);
}

test("@soak @S-07 Cache churn", async ({ page, baseURL, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = safeMarker(`S07-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`);
  const activeTerminals = new Map<string, FixtureTerminal>();
  const allTerminals = new Map<string, FixtureTerminal>();
  const evictedTerminals: FixtureTerminal[] = [];
  const samples: ResourceSample[] = [];
  try {
    await page.addInitScript(() => {
      const target = window as E2EWindow;
      const nativeGetContext = HTMLCanvasElement.prototype.getContext;
      const webglCanvases = new WeakSet<HTMLCanvasElement>();
      HTMLCanvasElement.prototype.getContext = function patchedGetContext(
        this: HTMLCanvasElement,
        contextId: string,
        options?: unknown,
      ): unknown {
        const getContext = nativeGetContext as unknown as (id: string, attributes?: unknown) => unknown;
        const context = getContext.call(this, contextId, options);
        if (context && (contextId === "webgl" || contextId === "webgl2" || contextId === "experimental-webgl")) webglCanvases.add(this);
        return context;
      } as typeof HTMLCanvasElement.prototype.getContext;
      target.__TERM_SERVER_E2E_RENDERER_RESOURCES__ = { isWebGLCanvas: (canvas) => webglCanvases.has(canvas) };

      const activeTimers = new Set<number>();
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeClearTimeout = window.clearTimeout.bind(window);
      const nativeSetInterval = window.setInterval.bind(window);
      const nativeClearInterval = window.clearInterval.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        let timerId = 0;
        const wrapped = typeof handler === "function"
          ? (...callbackArgs: unknown[]) => {
            activeTimers.delete(timerId);
            (handler as (...innerArgs: unknown[]) => void)(...callbackArgs);
          }
          : handler;
        timerId = nativeSetTimeout(wrapped, timeout, ...args);
        activeTimers.add(timerId);
        return timerId;
      }) as typeof window.setTimeout;
      window.clearTimeout = ((timerId?: number) => {
        if (timerId !== undefined) activeTimers.delete(timerId);
        nativeClearTimeout(timerId);
      }) as typeof window.clearTimeout;
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const timerId = nativeSetInterval(handler, timeout, ...args);
        activeTimers.add(timerId);
        return timerId;
      }) as typeof window.setInterval;
      window.clearInterval = ((timerId?: number) => {
        if (timerId !== undefined) activeTimers.delete(timerId);
        nativeClearInterval(timerId);
      }) as typeof window.clearInterval;

      let activeListeners = 0;
      const listeners = new WeakMap<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
      const listenerKey = (type: string, options?: boolean | AddEventListenerOptions) => `${type}:${typeof options === "boolean" ? options : Boolean(options?.capture)}`;
      const nativeAdd = EventTarget.prototype.addEventListener;
      const nativeRemove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function patchedAdd(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void {
        if (listener) {
          const key = listenerKey(type, options);
          let targetListeners = listeners.get(this);
          if (!targetListeners) {
            targetListeners = new Map();
            listeners.set(this, targetListeners);
          }
          let registered = targetListeners.get(key);
          if (!registered) {
            registered = new Set();
            targetListeners.set(key, registered);
          }
          if (!registered.has(listener)) {
            registered.add(listener);
            activeListeners += 1;
          }
        }
        nativeAdd.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function patchedRemove(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ): void {
        if (listener) {
          const key = listenerKey(type, options);
          const targetListeners = listeners.get(this);
          const registered = targetListeners?.get(key);
          if (registered?.delete(listener)) activeListeners -= 1;
        }
        nativeRemove.call(this, type, listener, options);
      };
      target.__TERM_SERVER_E2E_RESOURCE_COUNTERS__ = {
        read: () => ({ timerCount: activeTimers.size, listenerCount: activeListeners }),
      };
    });

    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const settings = await workbench.openSettings();
    await settings.setToggle("Tile new terminals", true);
    await settings.setToggle("Confirm before killing terminals", true);
    await settings.setCachedTerminalLimit(CACHE_LIMIT);
    await expect(settings.root.getByRole("slider", { name: "Terminals kept alive off screen", exact: true })).toHaveValue(String(CACHE_LIMIT));
    await expect(settings.root.getByRole("checkbox", { name: "Tile new terminals", exact: true })).toBeChecked();
    await expect(settings.root.getByRole("checkbox", { name: "Confirm before killing terminals", exact: true })).toBeChecked();
    await workbench.closeSettings();

    for (let index = 0; index < ITERATIONS; index += 1) {
      const beforeMounted = await workbench.terminalPaneIds();
      const beforeVisible = await readVisibleTerminalIds(page);
      expect(beforeMounted.length).toBeLessThanOrEqual(MOUNT_WINDOW);
      expect(beforeVisible.length).toBe(Math.min(MAX_VISIBLE_PANES, activeTerminals.size));
      const expectedEvicted = beforeMounted.length === MOUNT_WINDOW
        ? beforeMounted.find((id) => !beforeVisible.includes(id))
        : undefined;
      const expectedUnmount = expectedEvicted
        ? waitForTerminalEvent(page, expectedEvicted, "unmount", { timeout: WAIT_TIMEOUT_MS })
        : undefined;
      const terminal = await createFixtureTerminal(page, workbench, server, [...allTerminals.keys()], runTag, index);
      allTerminals.set(terminal.id, terminal);
      activeTerminals.set(terminal.id, terminal);
      const afterMounted = await workbench.terminalPaneIds();
      const evictedNow = beforeMounted.filter((id) => !afterMounted.includes(id) && id !== terminal.id);
      expect(evictedNow).toHaveLength(expectedEvicted ? 1 : 0);
      if (expectedEvicted) {
        expect(evictedNow[0]).toBe(expectedEvicted);
        const unmounted = await expectedUnmount!;
        expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
        expect(unmounted.snapshot.activeSocketCount).toBe(0);
        expect(unmounted.snapshot.socket.activeCount).toBe(0);
        await assertEvictedPaneHasNoResources(page, expectedEvicted, `iteration ${index + 1} eviction`);
        evictedTerminals.push(activeTerminals.get(expectedEvicted)!);
      }
      const visibleAfter = await readVisibleTerminalIds(page);
      expect(visibleAfter.length).toBe(Math.min(MAX_VISIBLE_PANES, activeTerminals.size));
      expect(afterMounted.length).toBeLessThanOrEqual(MOUNT_WINDOW);

      if ((index + 1) % SAMPLE_INTERVAL === 0) {
        const target = evictedTerminals.shift();
        if (!target) throw new Error(`iteration ${index + 1}: no evicted terminal available for reopen`);
        const reopenedEviction = await reopenEvictedAndRemove(
          page,
          workbench,
          server,
          faultController,
          target,
          activeTerminals,
          index + 1,
        );
        activeTerminals.delete(target.id);
        expect(reopenedEviction).toHaveLength(1);
        const reopenedId = reopenedEviction[0]!;
        const reopenedRecord = activeTerminals.get(reopenedId);
        if (reopenedRecord) evictedTerminals.push(reopenedRecord);
        const sample = await readResourceSample(page, server, faultController, index + 1);
        samples.push(sample);
        expect(sample.terminalCount).toBe(activeTerminals.size);
        assertResourceWindow(sample, activeTerminals.size, `iteration ${index + 1}`);
        if (samples.length === 1) {
          expect(index + 1).toBe(BASELINE_ITERATION);
        } else {
          assertNoGrowth(sample, samples[0]!, `iteration ${index + 1}`);
        }
      } else if (index + 1 === BASELINE_ITERATION) {
        const sample = await readResourceSample(page, server, faultController, index + 1);
        samples.push(sample);
        expect(sample.terminalCount).toBe(activeTerminals.size);
        assertResourceWindow(sample, activeTerminals.size, `iteration ${index + 1}`);
      }
    }
    expect(samples).toHaveLength(1 + Math.floor(ITERATIONS / SAMPLE_INTERVAL));

    const baseline = samples[0]!;
    expect(baseline.iteration).toBe(BASELINE_ITERATION);
    for (const sample of samples) assertNoGrowth(sample, baseline, `sample ${String(sample.iteration)}`);
    assertMonotonicResourceTrend(samples, baseline);

    const activeId = await readActiveTerminalId(page);
    const active = activeTerminals.get(activeId);
    if (!active) throw new Error("S-07 final active terminal is missing from the model");
    const finalPane = workbench.terminal(active.id, active.name);
    await finalPane.expectVisible();
    await exerciseContinuedInput(page, server, finalPane, active, runTag, testInfo);
    const finalSnapshot = await terminalSnapshot(page, active.id);
    if (!finalSnapshot) throw new Error("S-07 final terminal diagnostics are unavailable");
    expect(finalSnapshot.lifecycle).toMatchObject({ mounted: true, visible: true, active: true, focused: true, acceptingInput: true });
    expect(finalSnapshot.activeSocketCount).toBe(1);
    assertNoPendingSynchronization(finalSnapshot);
    await expectConnectedTerminalInvariants(page, active.id, { timeout: WAIT_TIMEOUT_MS });

    const finalListingBeforeCleanup = await readTerminalListing(page);
    expect(finalListingBeforeCleanup).toHaveLength(activeTerminals.size);
    for (const terminal of activeTerminals.values()) {
      const listed = finalListingBeforeCleanup.find((candidate) => candidate.id === terminal.id);
      expect(listed, `${terminal.id}: active session disappeared before final cleanup`).toBeDefined();
      expect(listed?.pid).toBe(terminal.pid);
      await assertTranscriptHistory(server, terminal, false);
    }
    for (const terminal of allTerminals.values()) {
      if (!activeTerminals.has(terminal.id)) await assertTranscriptHistory(server, terminal, true);
    }

    for (const terminal of [...activeTerminals.values()]) {
      await removeTerminalThroughSidebar(page, workbench, server, faultController, terminal);
      activeTerminals.delete(terminal.id);
    }
    const finalListing = await readTerminalListing(page);
    expect(finalListing).toEqual([]);
    const finalResources = await readResourceSample(page, server, faultController, "final");
    expect(finalResources.terminalCount).toBe(0);
    expect(finalResources.browser.mountedPaneCount).toBe(0);
    expect(finalResources.browser.visiblePaneCount).toBe(0);
    expect(finalResources.browser.cachedPaneCount).toBe(0);
    expect(finalResources.browser.socketCount).toBe(0);
    expect(finalResources.browser.rendererCount).toBe(0);
    expect(finalResources.browser.canvasCount).toBe(0);
    expect(finalResources.browser.attachedCanvasCount).toBe(0);
    expect(finalResources.browser.diagnosticWebglContextCount).toBe(0);
    expect(finalResources.proxySocketCount).toBe(0);
    expect(finalResources.process.fixtureCount).toBe(0);
    expect(finalResources.process.processCount).toBeLessThanOrEqual(baseline.process.processCount);
    assertNoGrowth(finalResources, baseline, "final cleanup");
    await expect(workbench.editorGrid.locator(".pane-slot")).toHaveCount(0);

    const allTranscripts = await Promise.all([...allTerminals.values()].map(async (terminal) => ({
      terminal,
      transcript: await server.readTranscript(terminal.id),
    })));
    for (const { terminal, transcript } of allTranscripts) {
      expect(transcript.filter((entry) => entry.event === "error"), `${terminal.id}: fixture error after churn`).toEqual([]);
      expect(transcript.filter((entry) => entry.event === "ready" && entry.id === terminal.readyId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "print" && entry.id === terminal.printId && entry.text === terminal.printText)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(1);
    }
    assertNoUnexpectedProxyFaults(faultController.events);
    const browserFailures = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "console" && /^error:/i.test(entry.message)
      || /unhandled(?:promise)?|uncaught/i.test(entry.message)
    ));
    expect(browserFailures).toEqual([]);
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);

    await testInfo.attach("s-07-resource-metrics", {
      body: Buffer.from(JSON.stringify({
        seed: "0x5107",
        iterations: ITERATIONS,
        cacheLimit: CACHE_LIMIT,
        maxVisiblePanes: MAX_VISIBLE_PANES,
        baseline,
        samples,
        final: finalResources,
      }, null, 2), "utf8"),
      contentType: "application/json",
    });
  } finally {
    browserErrors.dispose();
  }
});
