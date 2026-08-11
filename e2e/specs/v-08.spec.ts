import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, type IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  terminalEvents,
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
import TerminalPanePage from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 20_000;
const DESKTOP_VIEWPORT = { width: 1_440, height: 900 };
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CreatedTerminal = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
};

type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type PaneGeometry = Rect & {
  readonly id: string;
  readonly normalized: Rect;
};

type LayoutGeometry = {
  readonly grid: Rect;
  readonly panes: readonly PaneGeometry[];
  readonly dividers: readonly {
    readonly path: string;
    readonly direction: string;
    readonly ratio: number;
  }[];
};

function marker(kind: string, id: string, value?: string): string {
  return value === undefined ? `[E2E:${kind}:${id}]` : `[E2E:${kind}:${id}:${value}]`;
}

function unexpectedBrowserErrors(entries: readonly { kind: string; message: string }[]): readonly unknown[] {
  return entries.filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
}

async function createTerminal(page: Page, cwd: string): Promise<CreatedTerminal> {
  return page.evaluate(async (workingDirectory) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: workingDirectory }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    const value = await response.json() as Partial<CreatedTerminal>;
    if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.cwd !== "string") {
      throw new Error("terminal creation response is missing identity");
    }
    return { id: value.id, name: value.name, cwd: value.cwd };
  }, cwd);
}

async function readLayoutGeometry(page: Page): Promise<LayoutGeometry> {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".editor-grid");
    if (!grid) throw new Error("editor grid is unavailable");
    const gridRect = grid.getBoundingClientRect();
    if (gridRect.width <= 0 || gridRect.height <= 0) throw new Error("editor grid has no measurable geometry");
    const rect = (element: HTMLElement): Rect => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const panes = [...grid.querySelectorAll<HTMLElement>(".pane-slot:not(.cached)")].map((element) => {
      const value = rect(element);
      const style = getComputedStyle(element);
      return {
        ...value,
        id: element.dataset.terminalId ?? "",
        normalized: {
          x: Number.parseFloat(style.left) / 100,
          y: Number.parseFloat(style.top) / 100,
          width: Number.parseFloat(style.width) / 100,
          height: Number.parseFloat(style.height) / 100,
        },
      };
    });
    const dividers = [...grid.querySelectorAll<HTMLElement>('[role="separator"][data-divider-path]')].map((element) => ({
      path: element.dataset.dividerPath ?? "",
      direction: element.dataset.dividerDirection ?? "",
      ratio: Number(element.getAttribute("aria-valuenow")),
    }));
    return {
      grid: { x: gridRect.x, y: gridRect.y, width: gridRect.width, height: gridRect.height },
      panes,
      dividers,
    };
  });
}

async function eventBoundary(page: Page, terminalId: string): Promise<number> {
  const events = await terminalEvents(page, terminalId);
  return events.reduce((largest, event) => Math.max(largest, event.id), -1);
}

async function waitForViewportSent(page: Page, terminalId: string, after: number): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, afterEventId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > afterEventId
        && event.type === "viewport"
        && event.data["source"] === "sent",
      { timeout, afterId: afterEventId },
    );
  }, { id: terminalId, afterEventId: after, timeout: WAIT_TIMEOUT_MS });
}

async function waitForCurrentGeometry(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const current = snapshot.viewport;
      const desired = snapshot.desiredViewport;
      const sent = snapshot.sentViewport;
      const server = snapshot.serverViewport;
      const same = (left: typeof current, right: typeof current | undefined) => {
        if (!right) return false;
        return left.cols === right.cols
          && left.rows === right.rows
          && left.pixelWidth === right.pixelWidth
          && left.pixelHeight === right.pixelHeight;
      };
      return snapshot.lifecycle.visible
        && snapshot.lifecycle.mounted
        && snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && same(current, desired)
        && same(current, sent)
        && same(current, server)
        && (snapshot.syncTarget === undefined
          || snapshot.committedSequence === undefined
          || snapshot.committedSequence >= snapshot.syncTarget);
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForResizeBarriers(
  page: Page,
  terminalIds: readonly string[],
): Promise<Promise<unknown>[]> {
  const afters = await Promise.all(terminalIds.map((terminalId) => eventBoundary(page, terminalId)));
  return afters.map((after, index) => (
    waitForViewportSent(page, terminalIds[index]!, after)
  ));
}

async function sendFixturePrint(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  id: string,
  text: string,
  testInfo: TestInfo,
): Promise<void> {
  const before = await screenshotRegion(page, pane.xtermHost);
  const transcript = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === id && entry.text === text,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`PRINT ${id} ${text}`, true);
  await transcript;
  await expectTerminalBuffer(page, terminalId, { contains: marker("PRINT", id, text), occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, pane.xtermHost, before, {
    minimumChangedRatio: 0.001,
    testInfo,
    artifactName: `v08-${id}-changed`,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.001,
    testInfo,
    artifactName: `v08-${id}-nonblank`,
  });
}

async function sendFixtureSize(
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  id: string,
  snapshot: E2ETerminalSnapshot,
): Promise<void> {
  const transcript = server.waitForTranscript<{ event: string; id: string; rows: number; cols: number }>(
    terminalId,
    (entry) => entry.event === "size" && entry.id === id,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`SIZE ${id}`, true);
  const size = await transcript;
  const serverViewport = snapshot.serverViewport ?? snapshot.viewport;
  expect(size.rows).toBe(serverViewport.rows);
  expect(size.cols).toBe(serverViewport.cols);
}

async function sendFixtureInput(
  page: Page,
  server: IsolatedServer,
  pane: TerminalPanePage,
  terminalId: string,
  id: string,
  text: string,
): Promise<void> {
  const payload = Buffer.from(text, "utf8").toString("base64");
  const armed = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === id && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(`ECHO_INPUT ${id}`, true);
  await armed;
  const echoed = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === id
      && entry.phase === "payload"
      && entry.payload_base64 === payload,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(text, true);
  await echoed;
  await expectTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", id, payload),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
}

async function dragDivider(
  page: Page,
  separator: Locator,
  targetRatios: readonly number[],
  affectedTerminalIds: readonly string[],
): Promise<{ readonly x: number; readonly y: number }> {
  const layout = await readLayoutGeometry(page);
  const grid = layout.grid;
  const box = await separator.boundingBox();
  if (!box) throw new Error("split divider has no measurable hit target");
  const direction = await separator.getAttribute("data-divider-direction");
  if (direction !== "horizontal" && direction !== "vertical") throw new Error("split divider has no direction");
  const vertical = direction === "horizontal";
  const startX = vertical ? box.x : box.x + box.width / 2;
  // Avoid starting a root drag where a nested divider crosses it. The
  // overlapping hit areas otherwise let the nested divider capture pointerdown.
  const startY = vertical ? box.y + box.height * 0.25 : box.y;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  let finalPoint = { x: startX, y: startY };
  try {
    for (const ratio of targetRatios) {
      const barriers = await waitForResizeBarriers(page, affectedTerminalIds);
      finalPoint = vertical
        ? { x: grid.x + grid.width * ratio, y: startY }
        : { x: startX, y: grid.y + grid.height * ratio };
      await page.mouse.move(finalPoint.x, finalPoint.y, { steps: 5 });
      await Promise.all(barriers);
      await Promise.all(affectedTerminalIds.map((terminalId) => waitForCurrentGeometry(page, terminalId)));
      const current = Number(await separator.getAttribute("aria-valuenow"));
      expect(current).toBeGreaterThanOrEqual(MIN_SPLIT_RATIO);
      expect(current).toBeLessThanOrEqual(MAX_SPLIT_RATIO);
      expect(current).toBeCloseTo(ratio, 1);
    }
  } finally {
    await page.mouse.up();
  }
  return finalPoint;
}

function paneById(layout: LayoutGeometry, id: string): PaneGeometry {
  const pane = layout.panes.find((candidate) => candidate.id === id);
  if (!pane) throw new Error(`visible pane ${id} is missing from layout geometry`);
  return pane;
}

async function assertVisiblePanePolicy(page: Page, terminalIds: readonly string[]): Promise<readonly E2ETerminalSnapshot[]> {
  const workbench = new WorkbenchPage(page);
  for (const terminalId of terminalIds) {
    await expect(workbench.editorGrid.locator(`.pane-slot:not(.cached)[data-terminal-id="${terminalId}"]`)).toHaveCount(1);
  }
  const snapshots = await Promise.all(terminalIds.map((terminalId) => waitForCurrentGeometry(page, terminalId)));
  const activeSnapshots = snapshots.filter((snapshot) => snapshot.active);
  expect(activeSnapshots).toHaveLength(1);
  expect(activeSnapshots[0]?.lifecycle.acceptingInput).toBe(true);
  expect(snapshots.filter((snapshot) => snapshot.lifecycle.acceptingInput)).toHaveLength(1);
  expect(snapshots.filter((snapshot) => snapshot.focused).length).toBeLessThanOrEqual(1);
  for (const snapshot of snapshots) {
    expect(snapshot.lifecycle.visible).toBe(true);
    expect(snapshot.lifecycle.mounted).toBe(true);
    expect(snapshot.activeSocketCount).toBe(1);
  }
  return snapshots;
}

test("V-08 Split-pane drag converges browser, server, and PTY geometry @p1 @pr @nightly @resize @layout", async ({ page, baseURL, server }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(baseURL);
  await new LoginPage(page).login();

  const created = await Promise.all([
    createTerminal(page, server.dataDir),
    createTerminal(page, server.dataDir),
    createTerminal(page, server.dataDir),
  ]);
  await page.reload();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const panes = created.map((terminal) => new TerminalPanePage(page, terminal.id, terminal.name));
  await workbench.openTerminal({ id: created[0].id, name: created[0].name });
  await panes[0]!.expectVisible();
  await panes[0]!.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  await workbench.dragTerminalToSplit({ id: created[1].id, name: created[1].name }, created[0].id, "right");
  await panes[1]!.expectVisible();
  await panes[1]!.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  await workbench.dragTerminalToSplit({ id: created[2].id, name: created[2].name }, created[1].id, "bottom");
  await panes[2]!.expectVisible();
  await panes[2]!.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

  const terminalIds = created.map((terminal) => terminal.id);
  await assertVisiblePanePolicy(page, terminalIds);
  const initialLayout = await readLayoutGeometry(page);
  expect(initialLayout.panes).toHaveLength(3);
  expect(initialLayout.dividers).toHaveLength(2);
  expect(initialLayout.dividers.map((divider) => divider.path)).toEqual(["root", "second"]);
  const rootDivider = workbench.editorGrid.locator('[role="separator"][data-divider-path="root"]');
  const nestedDivider = workbench.editorGrid.locator('[role="separator"][data-divider-path="second"]');
  await expect(rootDivider).toHaveAttribute("aria-orientation", "vertical");
  await expect(nestedDivider).toHaveAttribute("aria-orientation", "horizontal");

  const rootFinalPointer = await dragDivider(page, rootDivider, [0.56, 0.63, 0.69, 0.72], terminalIds);
  const nestedFinalPointer = await dragDivider(page, nestedDivider, [0.39, 0.5, 0.61], [created[1]!.id, created[2]!.id]);
  const finalLayout = await readLayoutGeometry(page);
  const rootRatio = finalLayout.dividers.find((divider) => divider.path === "root")?.ratio;
  const nestedRatio = finalLayout.dividers.find((divider) => divider.path === "second")?.ratio;
  expect(rootRatio).toBeDefined();
  expect(nestedRatio).toBeDefined();
  expect(rootRatio!).toBeCloseTo((rootFinalPointer.x - finalLayout.grid.x) / finalLayout.grid.width, 2);
  const nestedFirst = paneById(finalLayout, created[1]!.id);
  const nestedSecond = paneById(finalLayout, created[2]!.id);
  const nestedTop = Math.min(nestedFirst.y, nestedSecond.y);
  const nestedHeight = nestedFirst.height + nestedSecond.height;
  expect(nestedRatio!).toBeCloseTo((nestedFinalPointer.y - nestedTop) / nestedHeight, 2);
  expect(rootRatio!).toBeGreaterThanOrEqual(MIN_SPLIT_RATIO);
  expect(rootRatio!).toBeLessThanOrEqual(MAX_SPLIT_RATIO);
  expect(nestedRatio!).toBeGreaterThanOrEqual(MIN_SPLIT_RATIO);
  expect(nestedRatio!).toBeLessThanOrEqual(MAX_SPLIT_RATIO);

  const finalSnapshots = await assertVisiblePanePolicy(page, terminalIds);
  for (const [index, terminal] of created.entries()) {
    const pane = panes[index]!;
    const snapshot = finalSnapshots[index]!;
    const screen = pane.xtermHost.locator(".xterm-screen");
    const screenBox = await screen.boundingBox();
    if (!screenBox || screenBox.width <= 0 || screenBox.height <= 0) {
      throw new Error(`terminal ${terminal.id} has no compositor screen geometry`);
    }
    expect(snapshot.pixelWidth).toBeGreaterThan(0);
    expect(snapshot.pixelHeight).toBeGreaterThan(0);
    expect(Math.abs(snapshot.pixelWidth - screenBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(snapshot.pixelHeight - screenBox.height)).toBeLessThanOrEqual(1);
    await expectTerminalConverged(page, terminal.id, {
      cols: snapshot.cols,
      rows: snapshot.rows,
      pixelWidth: snapshot.pixelWidth,
      pixelHeight: snapshot.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    await sendFixtureSize(server, pane, terminal.id, `V08_SIZE_${index}`, snapshot);
    await sendFixturePrint(page, server, pane, terminal.id, `V08_PRINT_${index}`, `split-${index}`, testInfo);
    await sendFixtureInput(page, server, pane, terminal.id, `V08_INPUT_${index}`, `V08_INPUT_PAYLOAD_${index}`);
  }

  await assertVisiblePanePolicy(page, terminalIds);
  for (const terminal of created) {
    await expectSingleTerminalSocket(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
    const invariant = await expectTerminalInvariants(page, terminal.id, { timeout: WAIT_TIMEOUT_MS });
    expect(invariant.snapshot.socketState).toBe("connected");
    expect(invariant.snapshot.activeSocketCount).toBe(1);
    await assertMonotonicSequences(invariant.events);
    expect(invariant.events.filter((event) => event.type === "error")).toHaveLength(0);
    const transcript = await server.readTranscript(terminal.id);
    expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  }
  expect(await page.locator(".resource-documents.visible").count()).toBe(0);
  expect(unexpectedBrowserErrors(browserErrors())).toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error|internal server error)/i);
  browserErrors.dispose();
});
