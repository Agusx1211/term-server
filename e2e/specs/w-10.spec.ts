import { Buffer } from "node:buffer";
import { expect, test, type IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
  E2ELifecycleSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { Page, TestInfo } from "@playwright/test";

const WAIT_TIMEOUT_MS = 45_000;
test.setTimeout(180_000);
const INITIAL_CACHE_LIMIT = 4;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
  readonly createdAt?: number;
  readonly clients?: number;
}

interface SizeTranscriptEntry extends Record<string, unknown> {
  readonly event: "size";
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width?: number;
  readonly pixel_height?: number;
}

interface WinchTranscriptEntry extends Record<string, unknown> {
  readonly event: "sigwinch";
  readonly rows: number;
  readonly cols: number;
}

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
  readonly mounted: E2ETerminalEvent;
}

function safeTag(testInfo: TestInfo): string {
  return `w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}-${testInfo.project.name}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
}

function cssAttribute(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function lastEventId(events: readonly E2ETerminalEvent[]): number {
  return events.at(-1)?.id ?? -1;
}

async function waitForNewMount(page: Page, knownIds: ReadonlySet<string>): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ ids, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && !ids.includes(event.terminalId),
      { timeout },
    );
  }, { ids: [...knownIds], timeout: WAIT_TIMEOUT_MS });
}

async function waitForMount(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      (event) => event.type === "mount" && event.terminalId === id,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  eventType: E2ETerminalEventType,
  lifecycle?: Partial<E2ELifecycleSnapshot>,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, type, expectedLifecycle, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => {
        if (event.id <= after || event.type !== type) return false;
        if (!expectedLifecycle) return true;
        return Object.entries(expectedLifecycle).every(([key, value]) => (
          event.snapshot.lifecycle[key as keyof typeof event.snapshot.lifecycle] === value
        ));
      },
      { timeout, afterId: after },
    );
  }, {
    id: terminalId,
    after: afterEventId,
    type: eventType,
    expectedLifecycle: lifecycle,
    timeout: WAIT_TIMEOUT_MS,
  });
}
async function waitForInteractive(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.lifecycle.mounted
      && snapshot.lifecycle.visible
      && snapshot.lifecycle.active
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}


async function readTerminals(page: Page): Promise<readonly TerminalApiInfo[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    return await response.json() as TerminalApiInfo[];
  });
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  const terminals = await readTerminals(page);
  const terminal = terminals.find((candidate) => candidate.id === terminalId);
  if (!terminal) throw new Error(`terminal ${terminalId} was not found in the server listing`);
  return terminal;
}

function expectProcessIdentity(
  current: TerminalApiInfo,
  initial: TerminalApiInfo,
  phase: string,
): void {
  expect(current.id, `${phase}: terminal id changed`).toBe(initial.id);
  expect(current.pid, `${phase}: PTY process identity changed`).toBe(initial.pid);
  expect(current.status, `${phase}: terminal is no longer running`).toBe("running");
}

function expectViewportMatchesFixture(
  snapshot: E2ETerminalSnapshot,
  size: SizeTranscriptEntry,
  phase: string,
): void {
  expect(snapshot.rows, `${phase}: browser rows disagree with SIZE`).toBe(size.rows);
  expect(snapshot.cols, `${phase}: browser columns disagree with SIZE`).toBe(size.cols);
  if (size.pixel_width !== undefined) expect(snapshot.pixelWidth, `${phase}: browser pixel width disagrees with SIZE`).toBe(size.pixel_width);
  if (size.pixel_height !== undefined) expect(snapshot.pixelHeight, `${phase}: browser pixel height disagrees with SIZE`).toBe(size.pixel_height);

  for (const [label, viewport] of [
    ["proposed", snapshot.proposedViewport],
    ["sent", snapshot.sentViewport],
    ["server", snapshot.serverViewport],
  ] as const) {
    expect(viewport, `${phase}: ${label} viewport is missing`).toBeDefined();
    if (!viewport) continue;
    expect(viewport.cols, `${phase}: ${label} viewport columns`).toBe(size.cols);
    expect(viewport.rows, `${phase}: ${label} viewport rows`).toBe(size.rows);
    if (size.pixel_width !== undefined) expect(viewport.pixelWidth, `${phase}: ${label} viewport pixel width`).toBe(size.pixel_width);
    if (size.pixel_height !== undefined) expect(viewport.pixelHeight, `${phase}: ${label} viewport pixel height`).toBe(size.pixel_height);
  }
}

async function assertFixtureGeometry(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  sizeId: string,
  phase: string,
): Promise<E2ETerminalSnapshot> {
  const sizeWait = server.waitForTranscript<SizeTranscriptEntry>(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await sizeWait;
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("SIZE", sizeId, String(size.rows), String(size.cols)),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const snapshot = await expectTerminalConverged(page, terminalId, {
    cols: size.cols,
    rows: size.rows,
    ...(size.pixel_width === undefined ? {} : { pixelWidth: size.pixel_width }),
    ...(size.pixel_height === undefined ? {} : { pixelHeight: size.pixel_height }),
  }, { timeout: WAIT_TIMEOUT_MS });
  expectViewportMatchesFixture(snapshot, size, phase);

  const transcript = await server.readTranscript<WinchTranscriptEntry>(terminalId);
  const matchingWinch = transcript.some((entry) => (
    entry.event === "sigwinch" && entry.rows === size.rows && entry.cols === size.cols
  ));
  expect(matchingWinch, `${phase}: fixture did not observe a matching SIGWINCH`).toBe(true);
  return snapshot;
}

async function createTerminal(
  page: Page,
  workbench: WorkbenchPage,
  knownIds: ReadonlySet<string>,
): Promise<CreatedTerminal> {
  const mountedPromise = waitForNewMount(page, knownIds);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const [response, mounted] = await Promise.all([responsePromise, mountedPromise]);
  expect(response.ok()).toBe(true);
  const created = await response.json() as Partial<TerminalApiInfo>;
  if (!created.id || !created.name) throw new Error("terminal creation response did not expose id and name");
  expect(mounted.terminalId).toBe(created.id);
  return { id: created.id, name: created.name, mounted };
}

function expectNoDiagnosticErrors(events: readonly E2ETerminalEvent[], phase: string): void {
  expect(events.filter((event) => event.type === "error"), `${phase}: diagnostics recorded an error`).toEqual([]);
  expect(events.filter((event) => event.type === "socket-stale"), `${phase}: stale socket event was recorded`).toEqual([]);
}

function indexOfTranscript(
  transcript: readonly Record<string, unknown>[],

  predicate: (entry: Record<string, unknown>) => boolean,
  label: string,
): number {
  const index = transcript.findIndex(predicate);
  if (index < 0) throw new Error(`fixture transcript is missing ${label}`);
  return index;
}
async function renameTerminal(
  page: Page,
  workbench: WorkbenchPage,
  terminal: CreatedTerminal,
  name: string,
): Promise<CreatedTerminal> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "PATCH"
      && url.pathname === `/api/terminals/${encodeURIComponent(terminal.id)}`;
  });
  await workbench.sidebar.renameTerminal({ id: terminal.id, name: terminal.name }, name);
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await expect(await workbench.sidebar.terminalRow({ id: terminal.id, name })).toBeVisible();
  return { ...terminal, name };
}

async function readAResources(page: Page, terminalId: string): Promise<{
  readonly mounted: boolean;
  readonly visible: boolean;
  readonly canvasCount: number;
  readonly attachedCanvasCount: number;
}> {
  return page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const snapshot = api.terminal(id);
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(`.pane-slot[data-terminal-id="${id.replace(/["\\]/g, "\\$&")}"] canvas` )];
    return {
      mounted: snapshot?.lifecycle.mounted ?? false,
      visible: snapshot?.lifecycle.visible ?? false,
      canvasCount: canvases.length,
      attachedCanvasCount: canvases.filter((canvas) => canvas.isConnected).length,
    };
  }, terminalId);
}
async function assertOnlyActiveTerminal(page: Page, phase: string): Promise<void> {
  const snapshots = await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals();
  });
  const visible = snapshots.filter((snapshot) => snapshot.lifecycle.visible);
  const active = visible.filter((snapshot) => snapshot.lifecycle.active);
  expect(active, `${phase}: visible terminals must have one active pane`).toHaveLength(1);
  for (const snapshot of visible) {
    if (snapshot.lifecycle.active) {
      expect(snapshot.lifecycle.acceptingInput, `${phase}: active terminal is not accepting input`).toBe(true);
      await expect(page.locator(
        `section[role="region"][data-terminal-id="${cssAttribute(snapshot.terminalId)}"] .xterm-helper-textarea`,
      ), `${phase}: active terminal input is not focused`).toBeFocused();
    } else {
      expect(snapshot.lifecycle.acceptingInput, `${phase}: inactive terminal retained input`).toBe(false);
    }
  }
}


test("W-10 Terminal process survives UI rearrangement @p1 @nightly", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = safeTag(testInfo);
  const terminalIds = new Set<string>();
  const phaseSnapshots: E2ETerminalSnapshot[] = [];
  let beforePixels: TerminalPixelImage | undefined;
  let finalBeforePixels: TerminalPixelImage | undefined;

  const readyId = `${runTag}-READY`;
  const beforePrintId = `${runTag}-BEFORE-PRINT`;
  const beforePrintText = `${runTag}-BEFORE-MARKER`;
  const initialSizeId = `${runTag}-INITIAL-SIZE`;
  const arrangedSizeId = `${runTag}-ARRANGED-SIZE`;
  const finalSizeId = `${runTag}-FINAL-SIZE`;
  const afterPrintId = `${runTag}-AFTER-PRINT`;
  const afterPrintText = `${runTag}-AFTER-MARKER`;
  const echoId = `${runTag}-CONTINUED-ECHO`;
  const echoPayload = `${runTag}-continued-input`;

  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const settings = await workbench.openSettings();
    await settings.setCachedTerminalLimit(INITIAL_CACHE_LIMIT);
    await expect(settings.root.getByRole("slider", {
      name: "Terminals kept alive off screen",
      exact: true,
    })).toHaveValue(String(INITIAL_CACHE_LIMIT));
    await workbench.closeSettings();

    const createdA = await renameTerminal(page, workbench, await createTerminal(page, workbench, terminalIds), `${runTag}-A`);
    terminalIds.add(createdA.id);
    const paneA = workbench.terminal(createdA.id, createdA.name);
    await paneA.expectVisible();
    const initial = await expectTerminalSynchronized(page, createdA.id, { timeout: WAIT_TIMEOUT_MS });
    expect(initial.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true });
    expect(initial.activeSocketCount).toBe(1);
    expect(initial.socket.activeCount).toBe(1);
    const initialTerminal = await readTerminal(page, createdA.id);
    expect(initialTerminal.status).toBe("running");
    if (initialTerminal.pid === null) throw new Error("W-10 initial terminal has no PTY process identity");

    const readyWait = server.waitForTranscript(
      createdA.id,
      (entry) => entry.event === "ready" && entry.id === readyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await paneA.sendInput(`READY ${readyId}`, true);
    await readyWait;

    beforePixels = await screenshotRegion(page, paneA.xtermHost);
    const beforeEvents = await terminalEvents(page, createdA.id);
    const beforeRender = waitForEventAfter(page, createdA.id, lastEventId(beforeEvents), "render");
    const beforePrintWait = server.waitForTranscript(
      createdA.id,
      (entry) => entry.event === "print" && entry.id === beforePrintId && entry.text === beforePrintText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await paneA.sendInput(`PRINT ${beforePrintId} ${beforePrintText}`, true);
    await beforePrintWait;
    await expectTerminalBuffer(page, createdA.id, {
      contains: marker("PRINT", beforePrintId, beforePrintText),
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await beforeRender;
    await expectKnownMarkerChanged(page, paneA.xtermHost, beforePixels, {
      minimumChangedRatio: 0.0002,
      testInfo,
      artifactName: "w-10-before-marker",
    });
    await expectTerminalNonBlank(page, paneA.xtermHost, {
      minimumNonBackgroundRatio: 0.001,
      testInfo,
      artifactName: "w-10-initial-terminal",
    });
    const initialGeometry = await assertFixtureGeometry(
      page,
      server,
      paneA,
      createdA.id,
      initialSizeId,
      "initial",
    );
    const createdB = await renameTerminal(page, workbench, await createTerminal(page, workbench, terminalIds), `${runTag}-B`);
    terminalIds.add(createdB.id);
    const paneB = workbench.terminal(createdB.id, createdB.name);
    await paneB.expectVisible();
    await expectTerminalSynchronized(page, createdB.id, { timeout: WAIT_TIMEOUT_MS });
    const terminalBInitial = await readTerminal(page, createdB.id);
    if (terminalBInitial.pid === null) throw new Error("W-10 B terminal has no PTY process identity");

    const createdC = await renameTerminal(page, workbench, await createTerminal(page, workbench, terminalIds), `${runTag}-C`);
    terminalIds.add(createdC.id);
    const paneC = workbench.terminal(createdC.id, createdC.name);
    await paneC.expectVisible();
    await expectTerminalSynchronized(page, createdC.id, { timeout: WAIT_TIMEOUT_MS });
    const terminalCInitial = await readTerminal(page, createdC.id);
    if (terminalCInitial.pid === null) throw new Error("W-10 C terminal has no PTY process identity");

    const aBeforeSplit = lastEventId(await terminalEvents(page, createdA.id));
    const aShown = waitForEventAfter(page, createdA.id, aBeforeSplit, "visibility", {
      mounted: true,
      visible: true,
      cached: false,
    });
    const aActive = waitForEventAfter(page, createdA.id, aBeforeSplit, "active", { active: true });
    const aInteractive = waitForInteractive(page, createdA.id);
    const splitA = await workbench.sidebar.splitTerminal({ id: createdA.id, name: createdA.name });
    await Promise.all([aShown, aActive, aInteractive]);
    await splitA.expectVisible();
    expect(await workbench.visiblePaneCount()).toBe(2);
    expect(await workbench.terminalPaneIds()).toEqual(expect.arrayContaining([createdA.id, createdC.id]));
    expectProcessIdentity(await readTerminal(page, createdA.id), initialTerminal, "split A");

    const bBeforeSplit = lastEventId(await terminalEvents(page, createdB.id));
    const bShown = waitForEventAfter(page, createdB.id, bBeforeSplit, "visibility", {
      mounted: true,
      visible: true,
      cached: false,
    });
    const bActive = waitForEventAfter(page, createdB.id, bBeforeSplit, "active", { active: true });
    const bInteractive = waitForInteractive(page, createdB.id);
    const splitB = await workbench.sidebar.splitTerminal({ id: createdB.id, name: createdB.name });
    await Promise.all([bShown, bActive, bInteractive]);
    await splitB.expectVisible();
    expect(await workbench.visiblePaneCount()).toBe(3);
    expect(await workbench.terminalPaneIds()).toEqual(expect.arrayContaining([createdA.id, createdB.id, createdC.id]));
    expectProcessIdentity(await readTerminal(page, createdA.id), initialTerminal, "split B");
    await assertOnlyActiveTerminal(page, "split terminals");

    const dragFloor = lastEventId(await terminalEvents(page, createdA.id));
    const draggedActive = waitForEventAfter(page, createdA.id, dragFloor, "active", {
      mounted: true,
      visible: true,
      cached: false,
      active: true,
    });
    await workbench.dragTerminalToSplit({ id: createdA.id, name: createdA.name }, createdC.id, "right");
    await draggedActive;
    await splitA.expectVisible();
    expect(await workbench.visiblePaneCount()).toBe(3);
    const arranged = await terminalSnapshot(page, createdA.id);
    if (!arranged) throw new Error("W-10 A diagnostics disappeared after drag rearrangement");
    expect(arranged.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true });
    phaseSnapshots.push(arranged);
    expectProcessIdentity(await readTerminal(page, createdA.id), initialTerminal, "drag A");
    const arrangedGeometry = await assertFixtureGeometry(
      page,
      server,
      splitA,
      createdA.id,
      arrangedSizeId,
      "arranged",
    );
    phaseSnapshots.push(arrangedGeometry);
    await assertOnlyActiveTerminal(page, "drag A");
    expectNoDiagnosticErrors(await terminalEvents(page, createdA.id), "arranged A");

    const switchAFloor = lastEventId(await terminalEvents(page, createdA.id));
    const switchBFloor = lastEventId(await terminalEvents(page, createdB.id));
    const aInactive = waitForEventAfter(page, createdA.id, switchAFloor, "active", { active: false });
    const bActivated = waitForEventAfter(page, createdB.id, switchBFloor, "active", {
      mounted: true,
      visible: true,
      cached: false,
      active: true,
    });
    await workbench.sidebar.openTerminal({ id: createdB.id, name: createdB.name });
    await Promise.all([aInactive, bActivated]);
    const switchedA = await terminalSnapshot(page, createdA.id);
    if (!switchedA) throw new Error("W-10 A diagnostics disappeared during pane switch");
    expect(switchedA.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: false, acceptingInput: false });
    expectProcessIdentity(await readTerminal(page, createdA.id), initialTerminal, "switch to B");
    expectProcessIdentity(await readTerminal(page, createdB.id), terminalBInitial, "switch to B identity");
    await assertOnlyActiveTerminal(page, "switch to B");

    const hideFloor = lastEventId(await terminalEvents(page, createdA.id));
    const hidden = waitForEventAfter(page, createdA.id, hideFloor, "visibility", {
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      acceptingInput: false,
    });
    await paneA.closePane();
    const hiddenEvent = await hidden;
    await workbench.expectCached(createdA.id);
    await paneA.expectHidden();
    expect(await workbench.visiblePaneCount()).toBe(2);
    expect(hiddenEvent.snapshot.activeSocketCount).toBeLessThanOrEqual(1);
    expectProcessIdentity(await readTerminal(page, createdA.id), initialTerminal, "hide A");
    phaseSnapshots.push(hiddenEvent.snapshot);

    const unmountFloor = lastEventId(await terminalEvents(page, createdA.id));
    const unmounted = waitForEventAfter(page, createdA.id, unmountFloor, "unmount", {
      mounted: false,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    const hiddenSettings = await workbench.openSettings();
    await hiddenSettings.setCachedTerminalLimit(0);
    await expect(hiddenSettings.root.getByRole("slider", {
      name: "Terminals kept alive off screen",
      exact: true,
    })).toHaveValue("0");
    const unmountEvent = await unmounted;
    expect(unmountEvent.snapshot.activeSocketCount).toBe(0);
    expect(unmountEvent.snapshot.socket.activeCount).toBe(0);
    expect(await readAResources(page, createdA.id)).toMatchObject({ mounted: false, visible: false, canvasCount: 0, attachedCanvasCount: 0 });
    await expect(page.locator(`.pane-slot[data-terminal-id="${cssAttribute(createdA.id)}"]`)).toHaveCount(0);
    await workbench.closeSettings();
    phaseSnapshots.push(unmountEvent.snapshot);
    expectProcessIdentity(await readTerminal(page, createdA.id), initialTerminal, "evict A resources");

    const remountPromise = waitForMount(page, createdA.id);
    const reopenedPane = await workbench.openTerminal({ id: createdA.id, name: createdA.name });
    const remounted = await remountPromise;
    expect(remounted.terminalId).toBe(createdA.id);
    await reopenedPane.expectVisible();
    const reopened = await expectTerminalSynchronized(page, createdA.id, { timeout: WAIT_TIMEOUT_MS });
    expect(reopened.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true, acceptingInput: true });
    expect(reopened.activeSocketCount).toBe(1);
    expect(reopened.socket.activeCount).toBe(1);
    expect(reopened.paneId).toBe(initial.paneId);
    phaseSnapshots.push(reopened);
    expectProcessIdentity(await readTerminal(page, createdA.id), initialTerminal, "reopen A");

    const switchCFloor = lastEventId(await terminalEvents(page, createdC.id));
    const cActivated = waitForEventAfter(page, createdC.id, switchCFloor, "active", {
      mounted: true,
      visible: true,
      cached: false,
      active: true,
    });
    await workbench.sidebar.openTerminal({ id: createdC.id, name: createdC.name });
    await cActivated;
    const finalDragFloor = lastEventId(await terminalEvents(page, createdA.id));
    const finalDraggedActive = waitForEventAfter(page, createdA.id, finalDragFloor, "active", {
      mounted: true,
      visible: true,
      cached: false,
      active: true,
    });
    await workbench.dragTerminalToSplit({ id: createdA.id, name: createdA.name }, createdC.id, "left");
    await finalDraggedActive;
    await reopenedPane.expectVisible();
    expect(await workbench.visiblePaneCount()).toBe(2);
    const finalBeforeGeometry = await terminalSnapshot(page, createdA.id);
    if (!finalBeforeGeometry) throw new Error("W-10 A diagnostics disappeared after reopen drag");
    expect(finalBeforeGeometry.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true });
    phaseSnapshots.push(finalBeforeGeometry);
    const finalGeometry = await assertFixtureGeometry(
      page,
      server,
      reopenedPane,
      createdA.id,
      finalSizeId,
      "reopened",
    );
    await assertOnlyActiveTerminal(page, "drag after reopen");
    phaseSnapshots.push(finalGeometry);
    expectProcessIdentity(await readTerminal(page, createdA.id), initialTerminal, "drag after reopen");

    finalBeforePixels = await screenshotRegion(page, reopenedPane.xtermHost);
    const finalEventsBefore = await terminalEvents(page, createdA.id);
    const finalRender = waitForEventAfter(page, createdA.id, lastEventId(finalEventsBefore), "render");
    const finalPrintWait = server.waitForTranscript(
      createdA.id,
      (entry) => entry.event === "print" && entry.id === afterPrintId && entry.text === afterPrintText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await reopenedPane.sendInput(`PRINT ${afterPrintId} ${afterPrintText}`, true);
    await finalPrintWait;
    await expectTerminalBuffer(page, createdA.id, {
      contains: marker("PRINT", afterPrintId, afterPrintText),
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await finalRender;
    await expectKnownMarkerChanged(page, reopenedPane.xtermHost, finalBeforePixels, {
      minimumChangedRatio: 0.0002,
      testInfo,
      artifactName: "w-10-after-marker",
    });

    const echoArmedWait = server.waitForTranscript(
      createdA.id,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await reopenedPane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await echoArmedWait;
    const echoPayloadWait = server.waitForTranscript(
      createdA.id,
      (entry) => entry.event === "echo_input"
        && entry.id === echoId
        && entry.phase === "payload"
        && entry.payload_base64 === Buffer.from(echoPayload, "utf8").toString("base64"),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await reopenedPane.sendInput(echoPayload, true);
    await echoPayloadWait;
    const echoMarker = marker("ECHO_INPUT", echoId, Buffer.from(echoPayload, "utf8").toString("base64"));
    await expectTerminalBuffer(page, createdA.id, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const finalSnapshot = await expectTerminalSynchronized(page, createdA.id, { timeout: WAIT_TIMEOUT_MS });
    expect(finalSnapshot.lifecycle).toMatchObject({ mounted: true, visible: true, cached: false, active: true, acceptingInput: true });
    expect(finalSnapshot.activeSocketCount).toBe(1);
    expect(finalSnapshot.socket.activeCount).toBe(1);
    expect(finalSnapshot.xterm.text).toContain(marker("PRINT", beforePrintId, beforePrintText));
    expect(finalSnapshot.xterm.text).toContain(marker("PRINT", afterPrintId, afterPrintText));
    expect(finalSnapshot.xterm.text).toContain(echoMarker);
    expect(finalSnapshot.xterm.text.split(marker("PRINT", beforePrintId, beforePrintText)).length - 1).toBe(1);
    expect(finalSnapshot.xterm.text.split(marker("PRINT", afterPrintId, afterPrintText)).length - 1).toBe(1);
    expect(finalSnapshot.xterm.text.split(echoMarker).length - 1).toBe(1);
    phaseSnapshots.push(finalSnapshot);

    const finalTranscript = await server.readTranscript(createdA.id);
    const beforePrintIndex = indexOfTranscript(finalTranscript, (entry) => entry.event === "print" && entry.id === beforePrintId && entry.text === beforePrintText, "initial PRINT");
    const initialSizeIndex = indexOfTranscript(finalTranscript, (entry) => entry.event === "size" && entry.id === initialSizeId, "initial SIZE");
    const arrangedSizeIndex = indexOfTranscript(finalTranscript, (entry) => entry.event === "size" && entry.id === arrangedSizeId, "arranged SIZE");
    const finalSizeIndex = indexOfTranscript(finalTranscript, (entry) => entry.event === "size" && entry.id === finalSizeId, "final SIZE");
    const afterPrintIndex = indexOfTranscript(finalTranscript, (entry) => entry.event === "print" && entry.id === afterPrintId && entry.text === afterPrintText, "final PRINT");
    const echoArmedIndex = indexOfTranscript(finalTranscript, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", "ECHO_INPUT arm");
    const echoPayloadIndex = indexOfTranscript(finalTranscript, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload" && entry.payload_base64 === Buffer.from(echoPayload, "utf8").toString("base64"), "ECHO_INPUT payload");
    const readyIndex = indexOfTranscript(finalTranscript, (entry) => entry.event === "ready" && entry.id === readyId, "READY");
    expect(readyIndex).toBeLessThan(beforePrintIndex);
    expect(beforePrintIndex).toBeLessThan(initialSizeIndex);
    expect(initialSizeIndex).toBeLessThan(arrangedSizeIndex);
    expect(arrangedSizeIndex).toBeLessThan(finalSizeIndex);
    expect(finalSizeIndex).toBeLessThan(afterPrintIndex);
    expect(afterPrintIndex).toBeLessThan(echoArmedIndex);
    expect(echoArmedIndex).toBeLessThan(echoPayloadIndex);
    expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === beforePrintId && entry.text === beforePrintText)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "print" && entry.id === afterPrintId && entry.text === afterPrintText)).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed")).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(finalTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);

    const finalEvents = await terminalEvents(page, createdA.id);
    expectNoDiagnosticErrors(finalEvents, "reopened A");
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "socket-open")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
    await expectNoPendingRecovery(page, createdA.id, { timeout: WAIT_TIMEOUT_MS });
    const invariantReport = await expectConnectedTerminalInvariants(page, createdA.id, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    assertNoUnexpectedSocketMultiplication([...phaseSnapshots, invariantReport.snapshot]);

    const finalA = await readTerminal(page, createdA.id);
    expectProcessIdentity(finalA, initialTerminal, "final A");
    expectProcessIdentity(await readTerminal(page, createdB.id), terminalBInitial, "final B");
    expectProcessIdentity(await readTerminal(page, createdC.id), terminalCInitial, "final C");
    const resources = await readAResources(page, createdA.id);
    expect(resources).toMatchObject({ mounted: true, visible: true, canvasCount: expect.any(Number), attachedCanvasCount: expect.any(Number) });
    expect(resources.canvasCount).toBeGreaterThan(0);
    expect(resources.attachedCanvasCount).toBe(resources.canvasCount);

    const networkEvents = faultController.events.filter((event: NetworkFaultEvent) => event.terminalId === createdA.id);
    expect(networkEvents.some((event) => event.type === "upgrade-open" || event.type === "connection-open")).toBe(true);
    expect(networkEvents.filter((event) => event.type === "socket-error" || event.type === "malformed-frame")).toEqual([]);
    expect(networkEvents.filter((event) => event.type === "connection-terminated" || event.type === "terminated")).toEqual([]);
    expect(page.getByText(/^Catching up/)).toHaveCount(0);
    expect(server.process?.exitCode ?? null).toBeNull();
    const browserFailures = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || entry.kind === "console" && /^error:/i.test(entry.message)
    ));
    expect(browserFailures).toEqual([]);
  } finally {
    browserErrors.dispose();
  }
});
