import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test, type IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
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

const WAIT_TIMEOUT_MS = 30_000;
const CACHE_LIMIT = 1;
const VIEWPORT = { width: 1_280, height: 800 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
  readonly createdAt: number;
  readonly clients: number;
}

interface SizeTranscriptEntry {
  readonly [key: string]: unknown;
  readonly event: "size";
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
}

interface ResourceCounts {
  readonly paneSlots: number;
  readonly visiblePaneSlots: number;
  readonly cachedPaneSlots: number;
  readonly canvasCount: number;
  readonly webglContextCount: number;
}

interface FixtureTerminal {
  readonly id: string;
  readonly name: string;
  readonly readyId: string;
  readonly seedId: string;
  readonly seedText: string;
  readonly seedMarker: string;
  pane: TerminalPanePage;
  readonly paneId: string;
  pid?: number;
}

function cssAttribute(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

async function readTerminalListing(page: Page): Promise<TerminalApiInfo[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    return await response.json() as TerminalApiInfo[];
  });
}

async function waitForSelectedTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
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
      && (
        snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget
      )
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}
async function waitForRenderedTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.rendererState.renderCount > 0, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForRenderAfter(
  page: Page,
  terminalId: string,
  eventFloor: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, floor, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > floor && event.type === "render", { timeout });
  }, { id: terminalId, floor: eventFloor, timeout: WAIT_TIMEOUT_MS });
}

async function waitForHiddenVisibilityAfter(
  page: Page,
  terminalId: string,
  eventFloor: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, floor, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > floor
      && event.type === "visibility"
      && event.data.visible === false
    ), { timeout });
  }, { id: terminalId, floor: eventFloor, timeout: WAIT_TIMEOUT_MS });
}

async function readResourceCounts(page: Page): Promise<ResourceCounts> {
  return page.evaluate(() => {
    const slots = [...document.querySelectorAll("main.editor-grid .pane-slot")];
    const visibleSlots = slots.filter((slot) => !slot.classList.contains("cached"));
    const cachedSlots = slots.filter((slot) => slot.classList.contains("cached"));
    const canvases = [...document.querySelectorAll("main.editor-grid .xterm-host canvas")] as HTMLCanvasElement[];
    let webglContextCount = 0;
    for (const canvas of canvases) {
      if (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) webglContextCount += 1;
    }
    return {
      paneSlots: slots.length,
      visiblePaneSlots: visibleSlots.length,
      cachedPaneSlots: cachedSlots.length,
      canvasCount: canvases.length,
      webglContextCount,
    } satisfies ResourceCounts;
  });
}

async function assertFocusRouting(
  page: Page,
  terminalIds: readonly string[],
  activeId: string,
): Promise<readonly E2ETerminalSnapshot[]> {
  const snapshots = await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminals();
  });
  const active = snapshots.filter((snapshot) => snapshot.active);
  const focused = snapshots.filter((snapshot) => snapshot.focused);
  const accepting = snapshots.filter((snapshot) => snapshot.acceptingInput);
  expect(active.map((snapshot) => snapshot.terminalId)).toEqual([activeId]);
  expect(focused.map((snapshot) => snapshot.terminalId)).toEqual([activeId]);
  expect(accepting.map((snapshot) => snapshot.terminalId)).toEqual([activeId]);
  for (const snapshot of snapshots) {
    expect(terminalIds).toContain(snapshot.terminalId);
    if (snapshot.terminalId !== activeId) {
      expect(snapshot.active).toBe(false);
      expect(snapshot.focused).toBe(false);
      expect(snapshot.acceptingInput).toBe(false);
    }
  }
  assertNoUnexpectedSocketMultiplication(snapshots);
  return snapshots;
}

function latestConnectionOpen(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
): NetworkFaultEvent | undefined {
  return [...events].reverse().find((event) => event.type === "connection-open" && event.terminalId === terminalId);
}

async function createFixtureTerminal(
  page: Page,
  workbench: WorkbenchPage,
  server: IsolatedServer,
  desiredName: string,
  runTag: string,
  index: number,
): Promise<FixtureTerminal> {
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as TerminalApiInfo;
  expect(created.id).not.toBe("");
  expect(created.name).not.toBe("");

  const readyId = `${runTag}-T${index}-READY`;
  const seedId = `${runTag}-T${index}-SEED`;
  const seedText = `${runTag}-T${index}-SEED-TEXT`;
  const seedMarker = `[E2E:PRINT:${seedId}:${seedText}]`;
  const createdPane = new TerminalPanePage(page, created.id, created.name);
  await createdPane.expectVisible();
  await expectTerminalSynchronized(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  await createdPane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    created.id,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await createdPane.sendInput(`PRINT ${seedId} ${seedText}`, true);
  await server.waitForTranscript(
    created.id,
    (entry) => entry.event === "print" && entry.id === seedId && entry.text === seedText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, created.id, { contains: seedMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await waitForRenderedTerminal(page, created.id);

  await workbench.sidebar.renameTerminal({ id: created.id, name: created.name }, desiredName);
  await expect((await workbench.sidebar.terminalRow(desiredName))).toBeVisible();
  const pane = new TerminalPanePage(page, created.id, desiredName);
  await pane.expectVisible();
  const initial = await terminalSnapshot(page, created.id);
  if (!initial) throw new Error(`missing diagnostics snapshot for ${created.id} after seed output`);
  const paneId = await workbench.paneInstanceId(created.id);
  expect(paneId).toBe(initial.paneId);
  return {
    id: created.id,
    name: desiredName,
    readyId,
    seedId,
    seedText,
    seedMarker,
    pane,
    paneId: initial.paneId,
  };
}

async function driveHeldPrint(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  stepId: string,
  stepText: string,
  gate: string,
): Promise<void> {
  await pane.sendInput(`HOLD ${gate}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "hold" && entry.token === gate,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:HOLD:${gate}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${stepId} ${stepText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command" && entry.operation === "PRINT" && entry.command_base64 === Buffer.from(`PRINT ${stepId} ${stepText}`).toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const releasePromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "release" && entry.token === gate,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const printPromise = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === stepId && entry.text === stepText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`RELEASE ${gate}`, true);
  await Promise.all([releasePromise, printPromise]);
}

test("W-05 Rapid terminal switching @p1 @chromium-pr @switching @nightly", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `W05-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalNames = ["W05-A", "W05-B", "W05-C", "W05-D"] as const;
  const terminals: FixtureTerminal[] = [];
  const expectedMounts = new Map<string, number>();
  const observedPaneIds = new Map<string, string>();
  let canvasCeiling = 0;
  let webglContextCeiling = 0;

  try {
    await page.setViewportSize(VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const settings = await workbench.openSettings();
    await settings.setCachedTerminalLimit(CACHE_LIMIT);
    await expect(settings.root.getByRole("slider", {
      name: "Terminals kept alive off screen",
      exact: true,
    })).toHaveValue(String(CACHE_LIMIT));
    await workbench.closeSettings();

    for (const [index, name] of terminalNames.entries()) {
      const terminal = await createFixtureTerminal(page, workbench, server, name, runTag, index);
      terminals.push(terminal);
      expectedMounts.set(terminal.id, 1);
      observedPaneIds.set(terminal.id, terminal.paneId);
      const resources = await readResourceCounts(page);
      canvasCeiling = Math.max(canvasCeiling, resources.canvasCount);
      webglContextCeiling = Math.max(webglContextCeiling, resources.webglContextCount);
      expect(resources.paneSlots).toBeLessThanOrEqual(CACHE_LIMIT);
      expect(resources.visiblePaneSlots).toBe(1);
    }
    expect(new Set(terminals.map((terminal) => terminal.id)).size).toBe(terminals.length);

    const baselineListing = await readTerminalListing(page);
    expect(baselineListing).toHaveLength(terminals.length);
    for (const terminal of terminals) {
      const listed = baselineListing.find((candidate) => candidate.id === terminal.id);
      if (!listed) throw new Error(`terminal ${terminal.id} missing from baseline server listing`);
      expect(listed.name).toBe(terminal.name);
      expect(listed.status).toBe("running");
      if (listed.pid === null) throw new Error(`terminal ${terminal.id} has no running fixture PID`);
      terminal.pid = listed.pid;
      expect(listed.clients).toBeLessThanOrEqual(1);
    }

    let activeTerminal = terminals[terminals.length - 1]!;
    let activePane = activeTerminal.pane;
    const visitOrder = [
      terminals[0]!,
      terminals[1]!,
      terminals[2]!,
      terminals[3]!,
      terminals[0]!,
      terminals[2]!,
      terminals[1]!,
      terminals[3]!,
      terminals[0]!,
    ];
    const stepExpectations = new Map<string, { id: string; text: string }[]>();
    const gates = new Map<string, string[]>();
    const sizes = new Map<string, string[]>();
    let stepNumber = 0;

    for (let round = 0; round < 2; round += 1) {
      for (const target of visitOrder) {
        const step = stepNumber;
        stepNumber += 1;
        const alreadySelected = activeTerminal.id === target.id;
        const targetEvents = await terminalEvents(page, target.id);
        const targetEventFloor = targetEvents.at(-1)?.id ?? 0;
        const selectedBarrier = waitForSelectedTerminal(page, target.id);
        const renderBarrier = alreadySelected
          ? Promise.resolve<E2ETerminalEvent | undefined>(undefined)
          : waitForRenderAfter(page, target.id, targetEventFloor);
        let hiddenBarrier: Promise<E2ETerminalEvent | undefined> = Promise.resolve(undefined);
        let unmountBarrier: Promise<E2ETerminalEvent | undefined> = Promise.resolve(undefined);
        let closedBarrier: Promise<NetworkFaultEvent | undefined> = Promise.resolve(undefined);
        if (!alreadySelected) {
          const activeBeforeSwitch = await terminalSnapshot(page, activeTerminal.id);
          if (!activeBeforeSwitch) throw new Error(`missing active diagnostics before switching from ${activeTerminal.name}`);
          const oldEvents = await terminalEvents(page, activeTerminal.id);
          const oldEventFloor = oldEvents.at(-1)?.id ?? 0;
          hiddenBarrier = waitForHiddenVisibilityAfter(page, activeTerminal.id, oldEventFloor);
          unmountBarrier = activePane.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
          const oldConnection = latestConnectionOpen(faultController.events, activeTerminal.id);
          if (!oldConnection || oldConnection.generation === undefined) {
            throw new Error(`missing reverse-proxy connection generation for ${activeTerminal.id}`);
          }
          closedBarrier = faultController.waitFor((event) => (
            (event.type === "connection-closed" || event.type === "connection-terminated")
            && event.terminalId === activeTerminal.id
            && event.generation === oldConnection.generation
          ), { timeoutMs: WAIT_TIMEOUT_MS });
        }

        const opened = await workbench.sidebar.openTerminal({ id: target.id, name: target.name });
        await opened.expectVisible();
        const [selected, renderEvent] = await Promise.all([selectedBarrier, renderBarrier]);
        expect(selected.lifecycle.visible).toBe(true);
        expect(selected.lifecycle.active).toBe(true);
        expect(selected.lifecycle.focused).toBe(true);
        expect(selected.lifecycle.acceptingInput).toBe(true);
        expect(selected.socketState).toBe("connected");
        expect(selected.activeSocketCount).toBe(1);
        if (!alreadySelected) {
          expect(renderEvent?.type).toBe("render");
          const [hidden, unmounted, closed] = await Promise.all([hiddenBarrier, unmountBarrier, closedBarrier]);
          expect(hidden?.snapshot.lifecycle.mounted).toBe(true);
          expect(hidden?.snapshot.lifecycle.visible).toBe(false);
          expect(hidden?.snapshot.lifecycle.cached).toBe(true);
          expect(hidden?.snapshot.lifecycle.active).toBe(false);
          expect(hidden?.snapshot.lifecycle.focused).toBe(false);
          expect(hidden?.snapshot.lifecycle.acceptingInput).toBe(false);
          expect(unmounted?.type).toBe("unmount");
          expect(unmounted?.snapshot.lifecycle.mounted).toBe(false);
          expect(unmounted?.snapshot.lifecycle.visible).toBe(false);
          expect(unmounted?.snapshot.lifecycle.cached).toBe(true);
          expect(unmounted?.snapshot.lifecycle.active).toBe(false);
          expect(unmounted?.snapshot.lifecycle.focused).toBe(false);
          expect(unmounted?.snapshot.lifecycle.acceptingInput).toBe(false);
          expect(unmounted?.snapshot.activeSocketCount).toBe(0);
          expect(unmounted?.snapshot.socket.activeCount).toBe(0);
          expect(unmounted?.snapshot.socketState).not.toBe("connected");
          expect(unmounted?.snapshot.socketState).not.toBe("connecting");
          expect(unmounted?.snapshot.socketState).not.toBe("recovering");
          expect(closed?.terminalId).toBe(activeTerminal.id);
          expect(await activePane.snapshot()).toBeUndefined();
          expect(await activePane.events()).toEqual([]);
          await expect(page.locator(`[data-terminal-id="${cssAttribute(activeTerminal.id)}"]`)).toHaveCount(0);
          expectedMounts.set(target.id, (expectedMounts.get(target.id) ?? 0) + 1);
        }

        target.pane = opened;
        activeTerminal = target;
        activePane = opened;
        const paneId = await workbench.paneInstanceId(target.id);
        expect(paneId).toBe(selected.paneId);
        expect(selected.paneId).toBe(observedPaneIds.get(target.id));
        expect(selected.renderer).toMatch(/^(webgl|canvas|dom)$/);
        expect(selected.rendererState.renderCount).toBeGreaterThan(0);
        expect(selected.webglLoadCount).toBeLessThanOrEqual(1);
        expect(selected.contextLossCount).toBe(0);
        expect(selected.activeSocketCount).toBe(1);
        expect(selected.socket.activeCount).toBe(1);
        expect(selected.lifecycle.mounted).toBe(true);
        expect(selected.lifecycle.cached).toBe(false);
        expect(selected.serverViewport).toBeDefined();
        expect(selected.serverViewport?.cols).toBe(selected.cols);
        expect(selected.serverViewport?.rows).toBe(selected.rows);
        await expectTerminalBuffer(page, target.id, { contains: target.seedMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
        await expectTerminalNonBlank(page, opened.xtermHost, {
          testInfo,
          artifactName: `w-05-${step}-reveal`,
        });

        const beforeStepPixels = await screenshotRegion(page, opened.xtermHost);
        const stepId = `${runTag}-T${terminals.indexOf(target)}-STEP-${step}`;
        const gate = `${runTag}-${target.name}-GATE-${step}`;
        const sizeId = `${runTag}-${target.name}-SIZE-${step}`;
        const stepText = `${runTag}-${target.name}-STEP-${step}-TEXT`;
        await driveHeldPrint(page, server, opened, target.id, stepId, stepText, gate);
        await expectTerminalBuffer(page, target.id, {
          contains: `[E2E:PRINT:${stepId}:${stepText}]`,
          occurrences: 1,
        }, { timeout: WAIT_TIMEOUT_MS });
        await expectTerminalNonBlank(page, opened.xtermHost, {
          testInfo,
          artifactName: `w-05-${step}-step`,
        });
        const afterStepPixels = await screenshotRegion(page, opened.xtermHost);
        await expectTerminalPixelsChanged(beforeStepPixels, afterStepPixels, {
          minimumChangedRatio: 0.002,
          testInfo,
          artifactName: `w-05-${step}-changed`,
        });

        await opened.sendInput(`SIZE ${sizeId}`, true);
        const sizeEntry = await server.waitForTranscript<SizeTranscriptEntry>(
          target.id,
          (entry) => entry.event === "size" && entry.id === sizeId,
          { timeoutMs: WAIT_TIMEOUT_MS },
        );
        const settled = await waitForSelectedTerminal(page, target.id);
        expect(sizeEntry.cols).toBe(settled.cols);
        expect(sizeEntry.rows).toBe(settled.rows);
        expect(settled.serverViewport?.cols).toBe(settled.cols);
        expect(settled.serverViewport?.rows).toBe(settled.rows);
        assertNoPendingSynchronization(settled);
        const snapshots = await assertFocusRouting(page, terminals.map((terminal) => terminal.id), target.id);
        expect(snapshots).toHaveLength(1);
        await expectConnectedTerminalInvariants(page, target.id, { timeout: WAIT_TIMEOUT_MS });
        const currentEvents = await terminalEvents(page, target.id);
        await assertMonotonicSequences(currentEvents);
        expect(currentEvents.filter((event) => event.type === "error")).toEqual([]);
        expect(currentEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
        expect(currentEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
        expect(currentEvents.filter((event) => event.type === "renderer-load" || event.type === "renderer-fallback")).toHaveLength(1);
        const resources = await readResourceCounts(page);
        expect(resources.paneSlots).toBeLessThanOrEqual(CACHE_LIMIT);
        expect(resources.visiblePaneSlots).toBe(1);
        expect(resources.cachedPaneSlots).toBe(0);
        expect(resources.canvasCount).toBeLessThanOrEqual(canvasCeiling);
        expect(resources.webglContextCount).toBeLessThanOrEqual(webglContextCeiling);
        await expect(workbench.editorGrid.locator(".pane-slot:not(.cached)")).toHaveCount(1);
        await workbench.expectVisibleTerminal(target.id);

        const terminalSteps = stepExpectations.get(target.id) ?? [];
        terminalSteps.push({ id: stepId, text: stepText });
        stepExpectations.set(target.id, terminalSteps);
        const terminalGates = gates.get(target.id) ?? [];
        terminalGates.push(gate);
        gates.set(target.id, terminalGates);
        const terminalSizes = sizes.get(target.id) ?? [];
        terminalSizes.push(sizeId);
        sizes.set(target.id, terminalSizes);
      }
    }

    const final = await terminalSnapshot(page, terminals[0]!.id);
    if (!final) throw new Error("missing final active terminal diagnostics");
    expect(final.lifecycle.visible).toBe(true);
    expect(final.lifecycle.active).toBe(true);
    expect(final.lifecycle.focused).toBe(true);
    expect(final.lifecycle.acceptingInput).toBe(true);
    expect(final.socketState).toBe("connected");
    expect(final.activeSocketCount).toBe(1);
    expect(final.socket.activeCount).toBe(1);
    assertNoPendingSynchronization(final);
    expect(final.renderBacklogBytes).toBe(0);
    expect(final.renderBacklogFrames).toBe(0);
    await assertFocusRouting(page, terminals.map((terminal) => terminal.id), terminals[0]!.id);

    const echoId = `${runTag}-CONTINUED-ECHO`;
    const echoText = `${runTag}-CONTINUED-INPUT`;
    await terminals[0]!.pane.sendInput(`ECHO_INPUT ${echoId} ${echoText}`, true);
    const echo = await server.waitForTranscript(
      terminals[0]!.id,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echo.text).toBe(echoText);
    await expectTerminalBuffer(page, terminals[0]!.id, {
      contains: `[E2E:ECHO_INPUT:${echoId}:${echoText}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    const continued = await waitForSelectedTerminal(page, terminals[0]!.id);
    expect(continued.acceptingInput).toBe(true);
    assertNoPendingSynchronization(continued);

    const finalListing = await readTerminalListing(page);
    expect(finalListing.map((terminal) => terminal.id).sort()).toEqual(terminals.map((terminal) => terminal.id).sort());
    expect(finalListing).toHaveLength(terminals.length);
    for (const terminal of terminals) {
      const listed = finalListing.find((candidate) => candidate.id === terminal.id);
      if (!listed) throw new Error(`terminal ${terminal.id} missing from final server listing`);
      expect(listed.status).toBe("running");
      expect(listed.pid).toBe(terminal.pid);
      expect(listed.clients).toBeGreaterThanOrEqual(0);
      expect(listed.clients).toBeLessThanOrEqual(1);
      const transcript = await server.readTranscript(terminal.id);
      expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
      expect(transcript.filter((entry) => entry.event === "ready" && entry.id === terminal.readyId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "print" && entry.id === terminal.seedId && entry.text === terminal.seedText)).toHaveLength(1);
      for (const step of stepExpectations.get(terminal.id) ?? []) {
        expect(transcript.filter((entry) => entry.event === "print" && entry.id === step.id && entry.text === step.text)).toHaveLength(1);
        expect(transcript.filter((entry) => entry.event === "command" && entry.operation === "PRINT" && entry.command_base64 === Buffer.from(`PRINT ${step.id} ${step.text}`).toString("base64"))).toHaveLength(1);
      }
      for (const gate of gates.get(terminal.id) ?? []) {
        expect(transcript.filter((entry) => entry.event === "hold" && entry.token === gate)).toHaveLength(1);
        expect(transcript.filter((entry) => entry.event === "release" && entry.token === gate)).toHaveLength(1);
      }
      for (const sizeId of sizes.get(terminal.id) ?? []) {
        expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
      }
      const echoEntries = transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload");
      expect(echoEntries).toHaveLength(terminal.id === terminals[0]!.id ? 1 : 0);
    }

    const networkEvents = faultController.events;
    for (const terminal of terminals) {
      const terminalNetworkEvents = networkEvents.filter((event) => event.terminalId === terminal.id);
      const opens = terminalNetworkEvents.filter((event) => event.type === "connection-open");
      const closes = terminalNetworkEvents.filter((event) => event.type === "connection-closed" || event.type === "connection-terminated");
      expect(opens).toHaveLength(expectedMounts.get(terminal.id) ?? 0);
      const liveConnections = opens.length - closes.length;
      expect(liveConnections).toBe(terminal.id === terminals[0]!.id ? 1 : 0);
      expect(terminalNetworkEvents.filter((event) => event.type === "upgrade-request")).toHaveLength(opens.length);
    }
    const finalResources = await readResourceCounts(page);
    expect(finalResources.paneSlots).toBe(1);
    expect(finalResources.visiblePaneSlots).toBe(1);
    expect(finalResources.cachedPaneSlots).toBe(0);
    expect(finalResources.canvasCount).toBeLessThanOrEqual(canvasCeiling);
    expect(finalResources.webglContextCount).toBeLessThanOrEqual(webglContextCeiling);
    expect(await workbench.mountedPaneCount()).toBe(1);
    expect(await workbench.visiblePaneCount()).toBe(1);
    expect(await workbench.statusText()).not.toMatch(/catching up|reconnect|synchroniz/i);
    await expect(workbench.statusbar).not.toContainText(/Catching up|reconnecting|synchronizing/i);
    const finalBrowserErrors = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
    ));
    expect(finalBrowserErrors).toEqual([]);
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
  } finally {
    browserErrors.dispose();
  }
});
