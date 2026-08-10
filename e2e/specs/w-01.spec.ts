import { test, expect } from "../fixtures/test.js";
import type { IsolatedServer } from "../fixtures/isolated-server.js";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { Page, Locator, TestInfo } from "@playwright/test";
import { LoginPage } from "../pages/login-page.js";
import { SettingsPage } from "../pages/settings-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 30_000;
const LARGER_CACHE_LIMIT = 4;
const CACHE_LIMIT_MAX = 64;

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

interface ClientConfig {
  readonly cachedTerminals: number;
  readonly maxPanes: number;
}

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly createdAt: number;
  readonly clients: number;
}

interface TestTerminal {
  readonly id: string;
  readonly name: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly pane: TerminalPanePage;
}

interface PrintExpectation {
  readonly id: string;
  readonly text: string;
  readonly marker: string;
}

interface EvictionRecord {
  readonly limit: number;
  readonly visibleId: string;
  readonly mountedBefore: readonly string[];
  readonly evicted: readonly string[];
}

interface SizeTranscriptEntry {
  readonly [key: string]: unknown;
  readonly event: "size";
  readonly id: string;
  readonly source?: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width?: number;
  readonly pixel_height?: number;
}

type LifecycleEventType = "mount" | "visibility" | "unmount" | "synced" | "render";

function markerForPrint(id: string, text: string): string {
  return `[E2E:PRINT:${id}:${text}]`;
}

function markerForEcho(id: string, text: string): string {
  return `[E2E:ECHO_INPUT:${id}:${Buffer.from(text, "utf8").toString("base64")}]`;
}

function countOccurrences(value: string, needle: string): number {
  const comparable = value.replaceAll("\n", "");
  let count = 0;
  let offset = 0;
  while ((offset = comparable.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length || 1;
  }
  return count;
}

function lastEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), 0);
}

function reconcileExpectedMounted(mounted: readonly string[], visibleId: string, limit: number): string[] {
  const protectedIds = new Set([visibleId]);
  const next = mounted.filter((id) => !protectedIds.has(id));
  next.push(visibleId);
  while (next.length > limit) {
    const inactiveIndex = next.findIndex((id) => !protectedIds.has(id));
    if (inactiveIndex < 0) break;
    next.splice(inactiveIndex, 1);
  }
  return next;
}

async function readConfig(page: Page): Promise<ClientConfig> {
  return page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`config request failed with HTTP ${response.status}`);
    const config = await response.json() as Partial<ClientConfig>;
    const cachedTerminals = config.cachedTerminals;
    const maxPanes = config.maxPanes;
    if (
      typeof cachedTerminals !== "number"
      || !Number.isInteger(cachedTerminals)
      || typeof maxPanes !== "number"
      || !Number.isInteger(maxPanes)
    ) {
      throw new Error("server config omitted cache or pane limits");
    }
    return { cachedTerminals, maxPanes };
  });
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} was not present in the server listing`);
    return terminal;
  }, terminalId);
}

async function mountedTerminalIds(page: Page): Promise<string[]> {
  return page.locator(".editor-grid .pane-slot").evaluateAll((slots) => (
    slots.map((slot) => slot.getAttribute("data-terminal-id")).filter((id): id is string => Boolean(id))
  ));
}

async function visibleTerminalId(page: Page): Promise<string> {
  const visible = page.locator(".editor-grid .pane-slot:not(.cached)");
  await expect(visible).toHaveCount(1);
  const id = await visible.first().getAttribute("data-terminal-id");
  if (!id) throw new Error("visible pane did not expose a terminal identity");
  return id;
}

async function paneSlot(page: Page, terminalId: string): Promise<Locator> {
  return page.locator(`.editor-grid .pane-slot[data-terminal-id="${terminalId}"]`);
}

async function waitForLifecycleEvent(
  page: Page,
  terminalId: string,
  afterId: number,
  types: readonly LifecycleEventType[],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, cursor, eventTypes, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const allowed = new Set(eventTypes);
    return api.waitForEvent(
      id,
      (event) => event.id > cursor && allowed.has(event.type as LifecycleEventType),
      { timeout },
    );
  }, { id: terminalId, cursor: afterId, eventTypes: types, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSelectedPane(
  page: Page,
  terminalId: string,
  minimumRenderCount = 0,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimumRender, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && snapshot.visible
      && snapshot.active
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.renderCount > minimumRender
    ), { timeout });
  }, { id: terminalId, minimumRender: minimumRenderCount, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCachedPane(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.mounted
      && !snapshot.visible
      && snapshot.cached
      && !snapshot.active
      && !snapshot.focused
      && !snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function assertMountedOrder(
  page: Page,
  workbench: WorkbenchPage,
  expected: readonly string[],
): Promise<void> {
  await expect(workbench.editorGrid.locator(".pane-slot")).toHaveCount(expected.length);
  await expect(workbench.editorGrid.locator(".pane-slot:not(.cached)")).toHaveCount(1);
  expect(await mountedTerminalIds(page)).toEqual(expected);
}

async function applyCacheLimit(
  page: Page,
  workbench: WorkbenchPage,
  settings: SettingsPage,
  requestedLimit: number,
  serverDefault: number,
  resetToDefault: boolean,
  evictionRecords: EvictionRecord[],
  evictedEvents: Map<string, E2ETerminalEvent[]>,
): Promise<string[]> {
  const mountedBefore = await mountedTerminalIds(page);
  const visibleId = await visibleTerminalId(page);
  const effectiveLimit = resetToDefault ? serverDefault : requestedLimit;
  const expected = reconcileExpectedMounted(mountedBefore, visibleId, effectiveLimit);
  const evicted = mountedBefore.filter((id) => !expected.includes(id));
  if (evicted.length > 0) {
    const firstInactive = mountedBefore.find((id) => id !== visibleId);
    expect(firstInactive).toBe(evicted[0]);
  }
  const unmountWaiters = new Map<string, Promise<E2ETerminalEvent>>();
  for (const terminalId of evicted) {
    const events = await terminalEvents(page, terminalId);
    unmountWaiters.set(
      terminalId,
      waitForLifecycleEvent(page, terminalId, lastEventId(events), ["unmount"]),
    );
  }

  if (resetToDefault) await settings.useServerCacheDefault();
  else await settings.setCachedTerminalLimit(requestedLimit);
  await expect(settings.root.getByRole("slider", { name: "Terminals kept alive off screen", exact: true }))
    .toHaveValue(String(effectiveLimit));

  const unmountResults = await Promise.all([...unmountWaiters.entries()].map(async ([terminalId, waiter]) => (
    [terminalId, await waiter] as const
  )));
  for (const [terminalId, event] of unmountResults) {
    const events = evictedEvents.get(terminalId) ?? [];
    events.push(event);
    evictedEvents.set(terminalId, events);
    expect(event.type).toBe("unmount");
    expect(event.snapshot.lifecycle).toMatchObject({
      mounted: false,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    expect(event.snapshot.activeSocketCount).toBe(0);
    expect(event.snapshot.socket.activeCount).toBe(0);
    expect(await (await paneSlot(page, terminalId)).count()).toBe(0);
  }

  await assertMountedOrder(page, workbench, expected);
  evictionRecords.push({
    limit: effectiveLimit,
    visibleId,
    mountedBefore,
    evicted,
  });
  for (const terminalId of expected) {
    if (terminalId === visibleId) continue;
    const cached = await waitForCachedPane(page, terminalId);
    expect(cached.lifecycle).toMatchObject({
      mounted: true,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    expect(cached.activeSocketCount).toBeLessThanOrEqual(1);
    if (cached.socketState === "connected") {
      expect(cached.activeSocketCount).toBe(1);
      expect(cached.serverViewport === undefined || cached.sentViewport !== undefined).toBe(true);
    }
    await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  }
  expect(expected.length).toBeLessThanOrEqual(Math.max(effectiveLimit, 1));
  return expected;
}

async function printAndAssertVisible(
  page: Page,
  server: IsolatedServerWaitForTranscript,
  terminal: TestTerminal,
  print: PrintExpectation,
  testInfo: TestInfo,
): Promise<void> {
  const beforePixels = await screenshotRegion(page, terminal.pane.xtermHost);
  await terminal.pane.sendInput(`PRINT ${print.id} ${print.text}`, true);
  await server.waitForTranscript(
    terminal.id,
    (entry) => entry.event === "print" && entry.id === print.id && entry.text === print.text,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminal.id, { contains: print.marker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const snapshot = await waitForSelectedPane(page, terminal.id);
  expect(countOccurrences(snapshot.xterm.text, print.marker)).toBe(1);
  await expectKnownMarkerChanged(page, terminal.pane.xtermHost, beforePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: `w01-${print.id}-marker`,
  });
  await expectTerminalNonBlank(page, terminal.pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: `w01-${print.id}-terminal`,
  });
  await expectConnectedTerminalInvariants(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
}

type IsolatedServerWaitForTranscript = Pick<IsolatedServer, "readTranscript" | "waitForTranscript">;

async function visitSequence(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServerWaitForTranscript,
  terminals: readonly TestTerminal[],
  limit: number,
  phase: string,
  runId: string,
  testInfo: TestInfo,
  printExpectations: Map<string, PrintExpectation[]>,
  evictionRecords: EvictionRecord[],
  evictedEvents: Map<string, E2ETerminalEvent[]>,
): Promise<string[]> {
  let mounted = await mountedTerminalIds(page);
  let currentVisible = await visibleTerminalId(page);
  const sequence = [...terminals, terminals[0]!];

  for (let visitIndex = 0; visitIndex < sequence.length; visitIndex += 1) {
    const terminal = sequence[visitIndex]!;
    const targetId = terminal.id;
    const targetBefore = await terminalSnapshot(page, targetId);
    const targetEvents = await terminalEvents(page, targetId);
    const targetCursor = targetBefore ? lastEventId(targetEvents) : 0;
    if (targetId !== currentVisible) {
      const previousEvents = await terminalEvents(page, currentVisible);
      const previousCursor = lastEventId(previousEvents);
      const previousWinches = (await server.readTranscript?.(currentVisible) ?? []).filter((entry) => entry.event === "sigwinch").length;
      const expected = reconcileExpectedMounted(mounted, targetId, limit);
      const evicted = mounted.filter((id) => !expected.includes(id));
      if (evicted.length > 0) {
        const firstInactive = mounted.find((id) => id !== targetId);
        expect(firstInactive).toBe(evicted[0]);
      }
      const previousTransition = waitForLifecycleEvent(page, currentVisible, previousCursor, ["visibility", "unmount"]);
      const targetTransition = waitForLifecycleEvent(page, targetId, targetCursor, ["mount", "visibility", "synced"]);
      const targetPane = await workbench.openTerminal({ id: targetId, name: terminal.name });
      await Promise.all([previousTransition, targetTransition]);
      const selected = await waitForSelectedPane(page, targetId, targetBefore?.renderCount ?? 0);
      expect(selected.lifecycle).toMatchObject({
        mounted: true,
        visible: true,
        active: true,
        socketState: "connected",
      });
      await targetPane.expectVisible();
      mounted = expected;
      currentVisible = targetId;
      await assertMountedOrder(page, workbench, mounted);
      for (const evictedId of evicted) {
        const events = evictedEvents.get(evictedId) ?? [];
        if (events.length === 0) {
          const unmount = await waitForLifecycleEvent(page, evictedId, 0, ["unmount"]);
          events.push(unmount);
          evictedEvents.set(evictedId, events);
        }
        const slot = await paneSlot(page, evictedId);
        await expect(slot).toHaveCount(0);
      }
      if (mounted.includes(currentVisible)) {
        for (const cachedId of mounted) {
          if (cachedId === currentVisible) continue;
          const cached = await waitForCachedPane(page, cachedId);
          await expectTerminalInvariants(page, cachedId, { timeout: WAIT_TIMEOUT_MS });
          expect(cached.activeSocketCount).toBeLessThanOrEqual(1);
        }
      }
      const previousAfter = await terminalSnapshot(page, currentVisible === targetId ? (sequence[Math.max(visitIndex - 1, 0)]?.id ?? "") : "");
      if (previousAfter === undefined && previousWinches >= 0) {
        const afterWinches = (await server.readTranscript?.(sequence[Math.max(visitIndex - 1, 0)]!.id) ?? []).filter((entry) => entry.event === "sigwinch").length;
        expect(afterWinches).toBe(previousWinches);
      }
      evictionRecords.push({
        limit,
        visibleId: targetId,
        mountedBefore: [...mounted.filter((id) => expected.includes(id) || evicted.includes(id))],
        evicted,
      });
    } else {
      await waitForSelectedPane(page, targetId);
      await assertMountedOrder(page, workbench, mounted);
    }

    const printId = `W01_${phase}_${terminal.name}_${visitIndex}_${runId}`;
    const printText = `${printId}_TEXT`;
    const print: PrintExpectation = {
      id: printId,
      text: printText,
      marker: markerForPrint(printId, printText),
    };
    const expectations = printExpectations.get(targetId) ?? [];
    expectations.push(print);
    printExpectations.set(targetId, expectations);
    await printAndAssertVisible(page, server, terminal, print, testInfo);
  }

  expect(currentVisible).toBe(terminals[0]!.id);
  return mounted;
}

async function unexpectedBrowserErrors(errors: BrowserErrorCollector): Promise<readonly unknown[]> {
  return errors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && entry.message.startsWith("error:")
  ));
}

test("W-01 Cache limits @nightly @p1 @chromium-pr @cache", async ({ page, baseURL, server }, testInfo) => {
  const runId = `W01_W${testInfo.workerIndex}_R${testInfo.retry}_I${testInfo.repeatEachIndex}`;
  const labels = ["A", "B", "C", "D", "E"] as const;
  const errors = installBrowserErrorCollectors(page);
  const printExpectations = new Map<string, PrintExpectation[]>();
  const evictedEvents = new Map<string, E2ETerminalEvent[]>();
  const evictionRecords: EvictionRecord[] = [];

  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const config = await readConfig(page);
    const serverDefault = Math.max(0, Math.min(CACHE_LIMIT_MAX, config.cachedTerminals));
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const settings = await workbench.openSettings();
    await settings.setToggle("Tile new terminals", false);
    await expect(settings.root.getByRole("checkbox", { name: "Tile new terminals", exact: true })).not.toBeChecked();
    await expect(settings.root.getByRole("slider", { name: "Terminals kept alive off screen", exact: true }))
      .toHaveValue(String(serverDefault));
    await workbench.showTerminals();

    const terminals: TestTerminal[] = [];
    for (const label of labels) {
      const createResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "POST" && url.pathname === "/api/terminals";
      });
      await workbench.createTerminal();
      const createResponse = await createResponsePromise;
      expect(createResponse.ok()).toBe(true);
      const created = await createResponse.json() as TerminalApiInfo;
      expect(created.id).not.toBe("");
      expect(created.status).toBe("running");
      if (created.pid === null) throw new Error(`terminal ${created.id} did not expose a running PID`);

      const renameResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "PATCH" && url.pathname === `/api/terminals/${created.id}`;
      });
      await workbench.sidebar.renameTerminal({ id: created.id, name: created.name }, `W01-${label}`);
      const renameResponse = await renameResponsePromise;
      expect(renameResponse.ok()).toBe(true);
      const name = `W01-${label}`;
      await expect(await workbench.sidebar.terminalRow({ id: created.id, name })).toBeVisible();
      const pane = workbench.terminal(created.id, name);
      await pane.expectVisible();
      await waitForSelectedPane(page, created.id);

      const readyId = `W01_READY_${label}_${runId}`;
      await pane.sendInput(`READY ${readyId}`, true);
      await server.waitForTranscript(
        created.id,
        (entry) => entry.event === "ready" && entry.id === readyId,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      const beforeId = `W01_BEFORE_${label}_${runId}`;
      const beforeText = `${beforeId}_TEXT`;
      const beforePrint: PrintExpectation = {
        id: beforeId,
        text: beforeText,
        marker: markerForPrint(beforeId, beforeText),
      };
      const expectations = printExpectations.get(created.id) ?? [];
      expectations.push(beforePrint);
      printExpectations.set(created.id, expectations);
      await printAndAssertVisible(page, server, { id: created.id, name, pid: created.pid, createdAt: created.createdAt, pane }, beforePrint, testInfo);

      terminals.push({ id: created.id, name, pid: created.pid, createdAt: created.createdAt, pane });
    }

    let mounted = await mountedTerminalIds(page);
    expect(mounted.length).toBeLessThanOrEqual(Math.max(serverDefault, 1));
    await assertMountedOrder(page, workbench, mounted);

    const phaseDefinitions: readonly { tag: string; limit: number; reset: boolean }[] = [
      { tag: "ZERO", limit: 0, reset: false },
      { tag: "ONE", limit: 1, reset: false },
      { tag: "DEFAULT", limit: serverDefault, reset: true },
      { tag: "LARGER", limit: LARGER_CACHE_LIMIT, reset: false },
    ];
    for (const phase of phaseDefinitions) {
      mounted = await applyCacheLimit(
        page,
        workbench,
        settings,
        phase.limit,
        serverDefault,
        phase.reset,
        evictionRecords,
        evictedEvents,
      );
      await workbench.showTerminals();
      mounted = await visitSequence(
        page,
        workbench,
        server,
        terminals,
        phase.limit,
        phase.tag,
        runId,
        testInfo,
        printExpectations,
        evictionRecords,
        evictedEvents,
      );
      expect(mounted.length).toBeLessThanOrEqual(Math.max(phase.limit, 1));
      expect(await workbench.mountedPaneCount()).toBe(mounted.length);
      expect(await workbench.visiblePaneCount()).toBe(1);
    }

    const finalTerminal = terminals[0]!;
    await finalTerminal.pane.expectVisible();
    await waitForSelectedPane(page, finalTerminal.id);
    const beforeInputPixels = await screenshotRegion(page, finalTerminal.pane.xtermHost);
    const echoId = `W01_ECHO_${runId}`;
    const echoText = `W01_CONTINUED_INPUT_${runId}`;
    await finalTerminal.pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(
      finalTerminal.id,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await finalTerminal.pane.sendInput(echoText, true);
    const echoed = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
      finalTerminal.id,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echoed.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
    const echoMarker = markerForEcho(echoId, echoText);
    await expectTerminalBuffer(page, finalTerminal.id, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const finalSnapshot = await waitForSelectedPane(page, finalTerminal.id);
    expect(countOccurrences(finalSnapshot.xterm.text, echoMarker)).toBe(1);
    await expectKnownMarkerChanged(page, finalTerminal.pane.xtermHost, beforeInputPixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "w01-continued-input-marker",
    });
    await expectTerminalNonBlank(page, finalTerminal.pane.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "w01-final-terminal",
    });
    await expectConnectedTerminalInvariants(page, finalTerminal.id, { timeout: WAIT_TIMEOUT_MS });

    const sizeId = `W01_SIZE_${runId}`;
    await finalTerminal.pane.sendInput(`SIZE ${sizeId}`, true);
    const size = await server.waitForTranscript<SizeTranscriptEntry>(
      finalTerminal.id,
      (entry) => entry.event === "size" && entry.id === sizeId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(size.rows).toBe(finalSnapshot.rows);
    expect(size.cols).toBe(finalSnapshot.cols);
    if (size.pixel_width !== undefined) expect(size.pixel_width).toBe(finalSnapshot.pixelWidth);
    if (size.pixel_height !== undefined) expect(size.pixel_height).toBe(finalSnapshot.pixelHeight);
    await expectTerminalConverged(page, finalTerminal.id, {
      cols: finalSnapshot.cols,
      rows: finalSnapshot.rows,
      pixelWidth: finalSnapshot.pixelWidth,
      pixelHeight: finalSnapshot.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });

    const finalMounted = await mountedTerminalIds(page);
    expect(finalMounted).toEqual(mounted);
    const snapshots: E2ETerminalSnapshot[] = [];
    for (const terminal of terminals) {
      const current = await terminalSnapshot(page, terminal.id);
      const transcript = await server.readTranscript(terminal.id);
      expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
      expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);
      expect(transcript.filter((entry) => entry.event === "ready" && entry.id === `W01_READY_${terminal.name.slice(-1)}_${runId}`)).toHaveLength(1);
      for (const print of printExpectations.get(terminal.id) ?? []) {
        expect(transcript.filter((entry) => entry.event === "print" && entry.id === print.id && entry.text === print.text)).toHaveLength(1);
      }
      const info = await readTerminal(page, terminal.id);
      expect(info.status).toBe("running");
      expect(info.pid).toBe(terminal.pid);
      expect(info.createdAt).toBe(terminal.createdAt);
      expect(info.clients).toBeLessThanOrEqual(1);
      if (current) {
        snapshots.push(current);
        await expectTerminalInvariants(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
        await assertMonotonicSequences(await terminalEvents(page, terminal.id));
        expect(current.lifecycle.mounted).toBe(true);
        if (current.lifecycle.visible) {
          expect(current.lifecycle.active).toBe(true);
          expect(current.lifecycle.acceptingInput).toBe(true);
        } else {
          expect(current.lifecycle.cached).toBe(true);
          expect(current.lifecycle.active).toBe(false);
          expect(current.lifecycle.focused).toBe(false);
          expect(current.lifecycle.acceptingInput).toBe(false);
        }
      } else {
        expect(finalMounted).not.toContain(terminal.id);
        const events = evictedEvents.get(terminal.id) ?? [];
        expect(events.length).toBeGreaterThan(0);
        expect(events.at(-1)?.snapshot.activeSocketCount).toBe(0);
      }
    }
    assertNoUnexpectedSocketMultiplication(snapshots);
    expect(evictionRecords.length).toBeGreaterThan(0);
    for (const record of evictionRecords) {
      if (record.evicted.length === 0) continue;
      const firstInactive = record.mountedBefore.find((id) => id !== record.visibleId);
      expect(record.evicted[0]).toBe(firstInactive);
    }

    const browserErrors = await unexpectedBrowserErrors(errors);
    expect(browserErrors).toEqual([]);
  } finally {
    errors.dispose();
  }
});
