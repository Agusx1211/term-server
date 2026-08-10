import { Buffer } from "node:buffer";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultController } from "../fixtures/network-faults.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 45_000;

// Different active-pane geometries make a stale released viewport observable:
// each re-open must negotiate the size of the pane that is actually on screen,
// not the size left behind by an older cached pane.
const VIEWPORTS = {
  A: { width: 1_280, height: 800 },
  B: { width: 1_120, height: 760 },
  C: { width: 1_000, height: 720 },
  D: { width: 900, height: 680 },
} as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: "running" | "exited";
  readonly clients: number;
  readonly createdAt: number;
};

type SizeTranscript = TranscriptEntry & {
  readonly event: "size";
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width: number;
  readonly pixel_height: number;
  readonly source: string;
};

type PaneRecord = {
  readonly id: string;
  readonly name: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly initialPaneId: string;
  readonly initialMarker: string;
  readonly printId: string;
  readonly printText: string;
  readonly initialViewport: E2EViewport;
  paneId: string;
  generation: number;
};
function parseTerminalInfo(value: unknown): TerminalApiInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("terminal API response was not an object");
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const pid = candidate.pid;
  const status = candidate.status;
  const clients = candidate.clients;
  const createdAt = candidate.createdAt;
  if (
    typeof id !== "string"
    || typeof name !== "string"
    || (status !== "running" && status !== "exited")
    || (pid !== null && typeof pid !== "number")
    || typeof clients !== "number"
    || typeof createdAt !== "number"
  ) {
    throw new Error("terminal API response has an invalid identity or lifecycle shape");
  }
  return { id, name, pid, status, clients, createdAt };
}

function parseTerminalList(value: unknown): TerminalApiInfo[] {
  if (!Array.isArray(value)) throw new Error("terminal listing response was not an array");
  return value.map((candidate) => parseTerminalInfo(candidate));
}

type PaneWithPage = {
  readonly page: Page;
  readonly xtermHost: Locator;
  readonly terminalId: string;
  sendInput(text: string, submit?: boolean): Promise<void>;
};
type LifecycleExpectation = "active" | "cached";

function marker(operation: string, id: string, text?: string): string {
  return text === undefined
    ? `[E2E:${operation}:${id}]`
    : `[E2E:${operation}:${id}:${text}]`;
}

function cssAttribute(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function eventNumber(event: E2ETerminalEvent, key: string): number {
  const value = event.data[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`diagnostic ${event.type} event has no finite ${key}`);
  }
  return value;
}

function viewportOf(snapshot: E2ETerminalSnapshot): E2EViewport {
  return snapshot.serverViewport ?? snapshot.viewport;
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  const value = await page.evaluate(async () => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    return response.json();
  });
  const terminal = parseTerminalList(value).find((candidate) => candidate.id === terminalId);
  if (!terminal) throw new Error(`terminal ${terminalId} was not found in the server listing`);
  return terminal;
}

async function readServerCacheDefault(page: Page): Promise<number> {
  const value = await page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`configuration request failed with HTTP ${response.status}`);
    return response.json();
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server configuration response was not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.cachedTerminals !== "number" || !Number.isInteger(candidate.cachedTerminals)) {
    throw new Error("server configuration did not expose an integer cachedTerminals default");
  }
  return candidate.cachedTerminals;
}

async function createTerminalWithUi(page: Page, workbench: WorkbenchPage): Promise<TerminalApiInfo> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`terminal creation failed with HTTP ${response.status()}`);
  const terminal = parseTerminalInfo(await response.json());
  if (!terminal.id || !terminal.name) throw new Error("terminal creation response is missing identity");
  return terminal;
}

async function renameTerminalWithUi(
  page: Page,
  workbench: WorkbenchPage,
  terminal: TerminalApiInfo,
  name: string,
): Promise<TerminalApiInfo> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "PATCH" && url.pathname === `/api/terminals/${terminal.id}`;
  });
  await workbench.sidebar.renameTerminal({ id: terminal.id, name: terminal.name }, name);
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`terminal rename failed with HTTP ${response.status()}`);
  const renamed = parseTerminalInfo(await response.json());
  if (renamed.id !== terminal.id || renamed.name !== name) throw new Error("terminal rename response changed identity");
  await expect(workbench.sidebar.root.locator(".terminal-title").filter({ hasText: name })).toBeVisible();
  return renamed;
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEvent["type"],
  source?: string,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, eventSource, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > after
        && event.type === eventType
        && (eventSource === undefined || event.data.source === eventSource),
      { timeout },
    );
  }, { id: terminalId, after: afterEventId, eventType: type, eventSource: source, timeout: WAIT_TIMEOUT_MS });
}

async function waitForLifecycle(
  page: Page,
  terminalId: string,
  expected: LifecycleExpectation,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, lifecycle, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => lifecycle === "active"
      ? snapshot.lifecycle.mounted
        && snapshot.lifecycle.visible
        && snapshot.lifecycle.active
        && snapshot.lifecycle.acceptingInput
        && snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
      : snapshot.lifecycle.mounted
        && snapshot.lifecycle.cached
        && !snapshot.lifecycle.visible
        && !snapshot.lifecycle.active
        && !snapshot.lifecycle.acceptingInput
        && snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1, { timeout });
  }, { id: terminalId, lifecycle: expected, timeout: WAIT_TIMEOUT_MS });
}

async function latestEventId(page: Page, terminalId: string): Promise<number> {
  const events = await terminalEvents(page, terminalId);
  return events.reduce((largest, event) => Math.max(largest, event.id), -1);
}

function latestProxyGeneration(controller: NetworkFaultController, terminalId: string): number {
  const generations = controller.events
    .filter((event) => event.type === "connection-open" && event.terminalId === terminalId)
    .map((event) => event.generation)
    .filter((generation): generation is number => generation !== undefined);
  return generations.at(-1) ?? 0;
}

async function resizeActivePane(
  page: Page,
  pane: { readonly terminalId: string },
  viewport: { readonly width: number; readonly height: number },
): Promise<E2ETerminalSnapshot> {
  const before = await latestEventId(page, pane.terminalId);
  await page.setViewportSize(viewport);
  const sent = await waitForDiagnosticEventAfter(page, pane.terminalId, before, "viewport", "sent");
  const expected = {
    cols: eventNumber(sent, "cols"),
    rows: eventNumber(sent, "rows"),
    pixelWidth: eventNumber(sent, "pixelWidth"),
    pixelHeight: eventNumber(sent, "pixelHeight"),
  };
  return expectTerminalConverged(page, pane.terminalId, expected, { timeout: WAIT_TIMEOUT_MS });
}

async function waitForCommand(
  pane: PaneWithPage,
  server: IsolatedServer,
  terminalId: string,
  command: string,
  operation: string,
): Promise<void> {
  const commandPromise = server.waitForTranscript(
    terminalId,
    (entry) => (
      entry.event === "command"
      && entry.operation === operation
      && entry.command_base64 === commandBytes(command)
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(command, true);
  await commandPromise;
}

async function fixtureReady(
  pane: PaneWithPage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
): Promise<void> {
  const readyPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === id,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await waitForCommand(pane, server, terminalId, `READY ${id}`, "READY");
  await readyPromise;
  await expectTerminalBuffer(
    pane.page,
    terminalId,
    { contains: marker("READY", id), occurrences: 1 },
    { timeout: WAIT_TIMEOUT_MS },
  );
}

async function fixturePrint(
  pane: PaneWithPage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
  text: string,
  artifactName: string,
  testInfo: TestInfo,
): Promise<void> {
  const before = await screenshotRegion(pane.page, pane.xtermHost);
  const printPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === id && entry.text === text,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await waitForCommand(pane, server, terminalId, `PRINT ${id} ${text}`, "PRINT");
  await printPromise;
  await expectTerminalBuffer(
    pane.page,
    terminalId,
    { contains: marker("PRINT", id, text), occurrences: 1 },
    { timeout: WAIT_TIMEOUT_MS },
  );
  await expectKnownMarkerChanged(pane.page, pane.xtermHost, before, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName,
  });
  await expectTerminalNonBlank(pane.page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: `${artifactName}-nonblank`,
  });
}

async function fixtureSize(
  pane: PaneWithPage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
  snapshot: E2ETerminalSnapshot,
): Promise<SizeTranscript> {
  const sizePromise = server.waitForTranscript<SizeTranscript>(terminalId, (entry) => (
    entry.event === "size" && entry.id === id && entry.source === "ioctl"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await waitForCommand(pane, server, terminalId, `SIZE ${id}`, "SIZE");
  const size = await sizePromise;
  const viewport = viewportOf(snapshot);
  expect(size.cols).toBe(viewport.cols);
  expect(size.rows).toBe(viewport.rows);
  expect(size.pixel_width).toBe(viewport.pixelWidth);
  expect(size.pixel_height).toBe(viewport.pixelHeight);
  await expectTerminalBuffer(pane.page, terminalId, {
    contains: marker("SIZE", id, `${size.rows}:${size.cols}`),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  return size;
}

async function reopenEvictedPane(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  controller: NetworkFaultController,
  record: PaneRecord,
  previousActive: PaneRecord,
  viewport: { readonly width: number; readonly height: number },
  testInfo: TestInfo,
): Promise<{ readonly pane: TerminalPanePage; readonly snapshot: E2ETerminalSnapshot }> {
  const previousPane = workbench.terminal(previousActive.id, previousActive.name);
  await resizeActivePane(page, previousPane, viewport);
  const beforeEvents = await latestEventId(page, record.id);
  const beforeGeneration = latestProxyGeneration(controller, record.id);
  const mountPromise = waitForDiagnosticEventAfter(page, record.id, beforeEvents, "mount");
  const openPromise = controller.waitFor((event) => (
    event.type === "connection-open"
    && event.terminalId === record.id
    && (event.generation ?? 0) > beforeGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const pane = await workbench.openTerminal({ id: record.id, name: record.name });
  await pane.expectVisible();
  await mountPromise;
  await openPromise;
  const snapshot = await expectTerminalSynchronized(page, record.id, { timeout: WAIT_TIMEOUT_MS });
  expect(snapshot.paneId).not.toBe(record.initialPaneId);
  record.paneId = snapshot.paneId;
  record.generation = latestProxyGeneration(controller, record.id);
  expect(await workbench.paneInstanceId(record.id)).toBe(snapshot.paneId);
  expect(snapshot.lifecycle.visible).toBe(true);
  expect(snapshot.lifecycle.acceptingInput).toBe(true);
  await expectTerminalConverged(page, record.id, {
    cols: viewportOf(snapshot).cols,
    rows: viewportOf(snapshot).rows,
    pixelWidth: viewportOf(snapshot).pixelWidth,
    pixelHeight: viewportOf(snapshot).pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, record.id, { contains: record.initialMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: `w08-${record.name.toLowerCase()}-reopen-nonblank`,
  });
  const reopenId = `${record.name}_REOPEN_PRINT`;
  const reopenText = `${record.name}_REOPEN_VISIBLE`;
  await fixturePrint(pane, server, record.id, reopenId, reopenText, `w08-${record.name.toLowerCase()}-reopen`, testInfo);
  const listing = await readTerminal(page, record.id);
  expect(listing.pid).toBe(record.pid);
  expect(listing.status).toBe("running");
  expect(listing.clients).toBe(1);
  await fixtureSize(pane, server, record.id, `${record.name}_REOPEN_SIZE`, snapshot);
  return { pane, snapshot };
}

async function continuedInput(
  pane: PaneWithPage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
  text: string,
  testInfo: TestInfo,
): Promise<void> {
  const armedPromise = server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === id && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await waitForCommand(pane, server, terminalId, `ECHO_INPUT ${id}`, "ECHO_INPUT");
  await armedPromise;
  const before = await screenshotRegion(pane.page, pane.xtermHost);
  const payloadPromise = server.waitForTranscript<{ event: string; id: string; phase: string; bytes: number; payload_base64: string }>(terminalId, (entry) => entry.event === "echo_input" && entry.id === id && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(text, true);
  const payload = await payloadPromise;
  expect(payload.bytes).toBe(Buffer.byteLength(text, "utf8"));
  expect(payload.payload_base64).toBe(Buffer.from(text, "utf8").toString("base64"));
  const expectedMarker = marker("ECHO_INPUT", id, payload.payload_base64);
  await expectTerminalBuffer(pane.page, terminalId, { contains: expectedMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(pane.page, pane.xtermHost, before, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName: `w08-${id.toLowerCase()}-continued-input`,
  });
}

// W-08 intentionally uses the browser cache setting with real populated PTYs.
// The viewport changes make a leaked cached size fail at the next SIZE barrier.
test("W-08 Change cache setting @nightly", async ({ page, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runId = `W${testInfo.workerIndex}R${testInfo.retry}I${testInfo.repeatEachIndex}`;
  const workbench = new WorkbenchPage(page);
  const records: PaneRecord[] = [];
  const viewportOrder = [
    ["A", VIEWPORTS.A],
    ["B", VIEWPORTS.B],
    ["C", VIEWPORTS.C],
    ["D", VIEWPORTS.D],
  ] as const;
  let serverDefault = 0;

  try {
    await page.setViewportSize(VIEWPORTS.A);
    await page.goto("/");
    await new LoginPage(page).login();
    await workbench.expectVisible();
    serverDefault = await readServerCacheDefault(page);

    for (const [letter, viewport] of viewportOrder) {
      const created = await createTerminalWithUi(page, workbench);
      const renamed = await renameTerminalWithUi(page, workbench, created, `W08-${letter}-${runId}`);
      const pane = workbench.terminal(renamed.id, renamed.name);
      await pane.expectVisible();
      await expectTerminalSynchronized(page, renamed.id, { timeout: WAIT_TIMEOUT_MS });
      if (viewport !== VIEWPORTS.A) await resizeActivePane(page, pane, viewport);
      const listing = await readTerminal(page, renamed.id);
      if (listing.pid === null) throw new Error(`terminal ${renamed.id} did not expose a fixture PID`);
      const readyId = `${renamed.name}_READY`;
      const printId = `${renamed.name}_PRINT`;
      const printText = `${renamed.name}_VISIBLE`;
      await fixtureReady(pane, server, renamed.id, readyId);
      await fixturePrint(pane, server, renamed.id, printId, printText, `w08-${letter.toLowerCase()}-initial`, testInfo);
      const snapshot = await terminalSnapshot(page, renamed.id);
      if (!snapshot) throw new Error(`diagnostics snapshot disappeared for ${renamed.id}`);
      expect(snapshot.lifecycle.visible).toBe(true);
      expect(snapshot.lifecycle.acceptingInput).toBe(true);
      await fixtureSize(pane, server, renamed.id, `${renamed.name}_INITIAL_SIZE`, snapshot);
      const paneId = await workbench.paneInstanceId(renamed.id);
      if (!paneId) throw new Error(`terminal ${renamed.id} did not expose a pane instance ID`);
      const generation = latestProxyGeneration(faultController, renamed.id);
      if (generation <= 0) throw new Error(`terminal ${renamed.id} did not expose a proxy connection generation`);
      records.push({
        id: renamed.id,
        name: renamed.name,
        pid: listing.pid,
        createdAt: listing.createdAt,
        initialPaneId: paneId,
        initialMarker: marker("PRINT", printId, printText),
        printId,
        printText,
        initialViewport: viewportOf(snapshot),
        paneId,
        generation,
      });
    }

    const [recordA, recordB, recordC, recordD] = records;
    if (!recordA || !recordB || !recordC || !recordD) throw new Error("W-08 did not create four terminal records");
    await waitForLifecycle(page, recordA.id, "cached");
    await waitForLifecycle(page, recordB.id, "cached");
    await waitForLifecycle(page, recordC.id, "cached");
    await waitForLifecycle(page, recordD.id, "active");
    expect(await workbench.mountedPaneCount()).toBe(4);
    expect(await workbench.terminalPaneIds()).toEqual([recordA.id, recordB.id, recordC.id, recordD.id]);
    for (const record of records) {
      const listing = await readTerminal(page, record.id);
      expect(listing.pid).toBe(record.pid);
      expect(listing.createdAt).toBe(record.createdAt);
      expect(listing.status).toBe("running");
      expect(listing.clients).toBe(1);
      const snapshot = await terminalSnapshot(page, record.id);
      if (!snapshot) throw new Error(`cached terminal ${record.id} has no diagnostics snapshot`);
      expect(snapshot.lifecycle.mounted).toBe(true);
      expect(snapshot.activeSocketCount).toBe(1);
    }

    const settings = await workbench.openSettings();
    const cacheSlider = settings.root.getByRole("slider", { name: "Terminals kept alive off screen", exact: true });
    const baselineEventIds = new Map<string, number>();
    for (const record of [recordA, recordB, recordC]) baselineEventIds.set(record.id, await latestEventId(page, record.id));
    const unmountPromises = [recordA, recordB, recordC].map((record) => waitForDiagnosticEventAfter(page, record.id, baselineEventIds.get(record.id) ?? -1, "unmount"));
    const closePromises = [recordA, recordB, recordC].map((record) => {
      const generation = record.generation;
      return faultController.waitFor((event) => (
        (event.type === "connection-closed" || event.type === "connection-terminated")
        && event.terminalId === record.id
        && event.generation === generation
      ), { timeoutMs: WAIT_TIMEOUT_MS });
    });
    await settings.setCachedTerminalLimit(1);
    await expect(cacheSlider).toHaveValue("1");
    expect(await page.evaluate(() => localStorage.getItem("term-server:cached-terminals"))).toBe("1");
    const [unmountEvents, closeEvents] = await Promise.all([Promise.all(unmountPromises), Promise.all(closePromises)]);
    await workbench.closeSettings();
    expect(await workbench.mountedPaneCount()).toBe(1);
    expect(await workbench.terminalPaneIds()).toEqual([recordD.id]);
    await workbench.expectVisibleTerminal(recordD.id);
    for (let index = 0; index < [recordA, recordB, recordC].length; index += 1) {
      const record = [recordA, recordB, recordC][index]!;
      const unmounted = unmountEvents[index]!;
      const closed = closeEvents[index]!;
      expect(unmounted.type).toBe("unmount");
      expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
      expect(unmounted.snapshot.lifecycle.visible).toBe(false);
      expect(unmounted.snapshot.lifecycle.acceptingInput).toBe(false);
      expect(unmounted.snapshot.activeSocketCount).toBe(0);
      expect(unmounted.snapshot.rendererState.renderCount).toBeGreaterThan(0);
      expect(closed.generation).toBe(record.generation);
      expect(await terminalSnapshot(page, record.id)).toBeUndefined();
      await expect(page.locator(`[data-terminal-id="${cssAttribute(record.id)}"] canvas`)).toHaveCount(0);
      const listing = await readTerminal(page, record.id);
      expect(listing.pid).toBe(record.pid);
      expect(listing.status).toBe("running");
      expect(listing.clients).toBe(0);
    }
    const afterLowerPane = workbench.terminal(recordD.id, recordD.name);
    const afterLower = await waitForLifecycle(page, recordD.id, "active");
    expect(afterLower.serverViewport).toEqual(recordD.initialViewport);
    await fixtureSize(afterLowerPane, server, recordD.id, `${recordD.name}_AFTER_LOWER_SIZE`, afterLower);
    await expectTerminalBuffer(page, recordD.id, { contains: recordD.initialMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, afterLowerPane.xtermHost, { minimumNonBackgroundRatio: 0.001, testInfo, artifactName: "w08-after-lower-nonblank" });

    const raisedSettings = await workbench.openSettings();
    const raisedSlider = raisedSettings.root.getByRole("slider", { name: "Terminals kept alive off screen", exact: true });
    await raisedSettings.setCachedTerminalLimit(3);
    await expect(raisedSlider).toHaveValue("3");
    expect(await page.evaluate(() => localStorage.getItem("term-server:cached-terminals"))).toBe("3");
    await workbench.closeSettings();

    const reopenedB = await reopenEvictedPane(page, workbench, server, faultController, recordB, recordD, VIEWPORTS.B, testInfo);
    await waitForLifecycle(page, recordD.id, "cached");
    const reopenedC = await reopenEvictedPane(page, workbench, server, faultController, recordC, recordB, VIEWPORTS.C, testInfo);
    await waitForLifecycle(page, recordB.id, "cached");
    await waitForLifecycle(page, recordD.id, "cached");
    expect(await workbench.mountedPaneCount()).toBe(3);
    expect(await workbench.terminalPaneIds()).toEqual([recordD.id, recordB.id, recordC.id]);

    const dBeforeEviction = await latestEventId(page, recordD.id);
    const dUnmountPromise = waitForDiagnosticEventAfter(page, recordD.id, dBeforeEviction, "unmount");
    const dClosePromise = faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === recordD.id
      && event.generation === recordD.generation
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const reopenedA = await reopenEvictedPane(page, workbench, server, faultController, recordA, recordC, VIEWPORTS.A, testInfo);
    const [dUnmount, dClose] = await Promise.all([dUnmountPromise, dClosePromise]);
    expect(dUnmount.snapshot.lifecycle.mounted).toBe(false);
    expect(dUnmount.snapshot.activeSocketCount).toBe(0);
    expect(dClose.generation).toBe(recordD.generation);
    expect(await terminalSnapshot(page, recordD.id)).toBeUndefined();
    await expect(page.locator(`[data-terminal-id="${cssAttribute(recordD.id)}"] canvas`)).toHaveCount(0);
    expect((await readTerminal(page, recordD.id)).clients).toBe(0);
    await waitForLifecycle(page, recordA.id, "active");
    await waitForLifecycle(page, recordB.id, "cached");
    await waitForLifecycle(page, recordC.id, "cached");
    expect(await workbench.mountedPaneCount()).toBe(3);
    expect(await workbench.terminalPaneIds()).toEqual([recordB.id, recordC.id, recordA.id]);

    const resetSettings = await workbench.openSettings();
    const resetSlider = resetSettings.root.getByRole("slider", { name: "Terminals kept alive off screen", exact: true });
    await resetSettings.useServerCacheDefault();
    await expect(resetSlider).toHaveValue(String(serverDefault));
    expect(await page.evaluate(() => localStorage.getItem("term-server:cached-terminals"))).toBeNull();
    await workbench.closeSettings();

    await resizeActivePane(page, reopenedA.pane, VIEWPORTS.D);
    const dBeforeRemount = await latestEventId(page, recordD.id);
    const dMountPromise = waitForDiagnosticEventAfter(page, recordD.id, dBeforeRemount, "mount");
    const dOpenBeforeRemount = latestProxyGeneration(faultController, recordD.id);
    const dOpenPromise = faultController.waitFor((event) => (
      event.type === "connection-open"
      && event.terminalId === recordD.id
      && (event.generation ?? 0) > dOpenBeforeRemount
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const finalDPane = await workbench.openTerminal({ id: recordD.id, name: recordD.name });
    await finalDPane.expectVisible();
    await dMountPromise;
    await dOpenPromise;
    const finalD = await expectTerminalSynchronized(page, recordD.id, { timeout: WAIT_TIMEOUT_MS });
    expect(finalD.paneId).not.toBe(recordD.initialPaneId);
    recordD.paneId = finalD.paneId;
    recordD.generation = latestProxyGeneration(faultController, recordD.id);
    await expectTerminalBuffer(page, recordD.id, { contains: recordD.initialMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, finalDPane.xtermHost, { minimumNonBackgroundRatio: 0.001, testInfo, artifactName: "w08-final-d-nonblank" });
    await fixtureSize(finalDPane, server, recordD.id, `${recordD.name}_FINAL_SIZE`, finalD);
    const finalPrintId = `${recordD.name}_FINAL_PRINT`;
    const finalPrintText = `${recordD.name}_FINAL_VISIBLE`;
    await fixturePrint(finalDPane, server, recordD.id, finalPrintId, finalPrintText, "w08-final-d-print", testInfo);
    const echoId = `${recordD.name}_CONTINUED_INPUT`;
    const echoText = `${recordD.name}_CONTINUED_PAYLOAD`;
    await continuedInput(finalDPane, server, recordD.id, echoId, echoText, testInfo);

    expect(await workbench.mountedPaneCount()).toBe(4);
    expect(await workbench.terminalPaneIds()).toEqual([recordB.id, recordC.id, recordA.id, recordD.id]);
    const finalSnapshots: E2ETerminalSnapshot[] = [];
    for (const record of records) {
      const snapshot = await terminalSnapshot(page, record.id);
      if (!snapshot) throw new Error(`final diagnostics snapshot disappeared for ${record.id}`);
      finalSnapshots.push(snapshot);
      await expectTerminalBuffer(page, record.id, { contains: record.initialMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      const events = await terminalEvents(page, record.id);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      await assertMonotonicSequences(events);
      await expectTerminalInvariants(page, record.id, { timeout: WAIT_TIMEOUT_MS });
      expect(snapshot.activeSocketCount).toBe(1);
      expect(snapshot.socketState).toBe("connected");
      if (record.id === recordD.id) {
        expect(snapshot.lifecycle.visible).toBe(true);
        expect(snapshot.lifecycle.acceptingInput).toBe(true);
      } else {
        expect(snapshot.lifecycle.mounted).toBe(true);
        expect(snapshot.lifecycle.cached).toBe(true);
        expect(snapshot.lifecycle.visible).toBe(false);
        expect(snapshot.lifecycle.acceptingInput).toBe(false);
      }
      const listing = await readTerminal(page, record.id);
      expect(listing.pid).toBe(record.pid);
      expect(listing.status).toBe("running");
      expect(listing.clients).toBe(1);
      expect(listing.createdAt).toBe(record.createdAt);
    }
    assertNoUnexpectedSocketMultiplication(finalSnapshots);
    const finalInvariant = await expectConnectedTerminalInvariants(page, recordD.id, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(page, recordD.id, { timeout: WAIT_TIMEOUT_MS });
    await expectSingleTerminalSocket(page, recordD.id, { timeout: WAIT_TIMEOUT_MS });
    expect(finalInvariant.snapshot.serverViewport).toBeDefined();
    expect(finalInvariant.snapshot.serverViewport?.cols).toBe(finalInvariant.snapshot.cols);
    expect(finalInvariant.snapshot.serverViewport?.rows).toBe(finalInvariant.snapshot.rows);
    expect(finalInvariant.snapshot.serverViewport?.pixelWidth).toBe(finalInvariant.snapshot.pixelWidth);
    expect(finalInvariant.snapshot.serverViewport?.pixelHeight).toBe(finalInvariant.snapshot.pixelHeight);
    const finalSize = await fixtureSize(finalDPane, server, recordD.id, `${recordD.name}_FINAL_SIZE_AGAIN`, finalInvariant.snapshot);
    expect(finalSize.cols).toBe(finalInvariant.snapshot.cols);
    expect(finalSize.rows).toBe(finalInvariant.snapshot.rows);

    for (const record of records) {
      const transcript = await server.readTranscript(record.id);
      expect(transcript.filter((entry) => entry.event === "error"), `${record.name} fixture errors`).toEqual([]);
    }
    const browserFailures = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "console" && /^error:/i.test(entry.message)
      || entry.kind === "requestfailed"
    ));
    expect(browserFailures, "unexpected browser errors").toEqual([]);
  } finally {
    browserErrors.dispose();
  }
});
