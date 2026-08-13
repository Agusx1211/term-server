import { Buffer } from "node:buffer";
import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import { expectTerminalBuffer } from "../assertions/terminal-state.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { TerminalPanePage } from "../pages/terminal-pane.js";

const WAIT_TIMEOUT_MS = 60_000;
const BURST_BYTES = 400_000;
const BURST_LINE_WIDTH = 80;
const MINIMUM_SCROLLBACK_LINES = 3_000;

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

async function createFixtureTerminal(page: Page, path: string, shell: string): Promise<{ id: string; name: string }> {
  return page.evaluate(async ({ path: terminalPath, shell: fixtureShell }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: terminalPath, cwd: "/tmp", shell: fixtureShell }),
    });
    if (!response.ok) throw new Error(`terminal creation failed with HTTP ${response.status}`);
    const payload = await response.json() as { id?: unknown; name?: unknown };
    if (typeof payload.id !== "string" || typeof payload.name !== "string") {
      throw new Error("terminal creation response is missing id or name");
    }
    return { id: payload.id, name: payload.name };
  }, { path, shell });
}

async function waitSettled(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.syncMode === undefined
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function snapshotOf(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  const snapshot = await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id);
  }, terminalId);
  if (!snapshot) throw new Error(`no diagnostics snapshot for terminal ${terminalId}`);
  return snapshot;
}

async function wheel(page: Page, pane: TerminalPanePage, deltaY: number, ticks: number): Promise<void> {
  const box = await pane.xtermHost.boundingBox();
  if (!box) throw new Error("terminal host has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < ticks; index += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(15);
  }
  await page.waitForTimeout(400);
}

/**
 * Wheel toward the bottom until the viewport stops making progress. A healthy
 * pane converges on viewportY === baseY; a stale scroll range stalls short of
 * it, which the caller's assertion then reports.
 */
async function wheelToBottom(page: Page, pane: TerminalPanePage, terminalId: string): Promise<E2ETerminalSnapshot> {
  let previous = -1;
  let snapshot = await snapshotOf(page, terminalId);
  while (snapshot.xterm.viewportY > previous && snapshot.xterm.viewportY < snapshot.xterm.baseY) {
    previous = snapshot.xterm.viewportY;
    await wheel(page, pane, 1_000, 25);
    snapshot = await snapshotOf(page, terminalId);
  }
  return snapshot;
}

async function setupLargeTerminal(page: Page, baseURL: string, fixturePath: string, tag: string): Promise<{
  pane: TerminalPanePage;
  terminalId: string;
  tailMarker: string;
}> {
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const created = await createFixtureTerminal(page, `v16-${tag}`, fixturePath);
  await page.reload();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const pane = await workbench.openTerminal({ id: created.id, name: created.name });
  await pane.expectVisible();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  await waitSettled(page, created.id);

  await pane.sendInput(`BURST ${tag} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
  await pane.sendInput(`PRINT ${tag}-TAIL V16-TAIL-${tag}`, true);
  const tailMarker = `[E2E:PRINT:${tag}-TAIL:V16-TAIL-${tag}]`;
  await expectTerminalBuffer(page, created.id, { contains: tailMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const settled = await waitSettled(page, created.id);
  expect(settled.xterm.baseY).toBeGreaterThan(MINIMUM_SCROLLBACK_LINES);
  return { pane, terminalId: created.id, tailMarker };
}

async function reconnectPane(page: Page, terminalId: string): Promise<TerminalPanePage> {
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const pane = await workbench.openTerminal({ id: terminalId, name: "" });
  await pane.expectVisible();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  await waitSettled(page, terminalId);
  return pane;
}

test("V-16 Rows shrink keeps the scrollback tail @p1 @pr @nightly @resize @scrollback", async ({
  page,
  baseURL,
  server,
}, testInfo) => {
  const tag = `A${testInfo.workerIndex}${testInfo.repeatEachIndex}${testInfo.retry}`;
  const { pane, terminalId, tailMarker } = await setupLargeTerminal(page, baseURL, server.fixturePath, tag);

  // Park the cursor mid-screen with content below it, the way an agent TUI
  // leaves its composer above the transcript tail. xterm's rows shrink used to
  // delete the lines below the cursor, and the damaged buffer was then
  // checkpointed to the server as the authoritative snapshot.
  const parkCursor = Buffer.from("\u001b[10;1H", "utf8").toString("hex");
  await pane.sendInput(`BYTES ${tag}-PARK ${parkCursor}`, true);
  await waitSettled(page, terminalId);
  const before = await snapshotOf(page, terminalId);

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.evaluate(async ({ id, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => snapshot.rows < rows, { timeout });
  }, { id: terminalId, rows: before.rows, timeout: WAIT_TIMEOUT_MS });
  await waitSettled(page, terminalId);
  const shrunk = await snapshotOf(page, terminalId);
  expect(shrunk.xterm.text.replaceAll("\n", "")).toContain(tailMarker);

  // The tail must also survive the checkpoint round-trip a refresh performs.
  await page.reload();
  await reconnectPane(page, terminalId);
  await expectTerminalBuffer(page, terminalId, { contains: tailMarker }, { timeout: WAIT_TIMEOUT_MS });
  const after = await snapshotOf(page, terminalId);
  expect(after.xterm.viewportY).toBe(after.xterm.baseY);
});

test("V-16 Refresh keeps the buffer tail reachable @p1 @pr @nightly @scrollback @reconnect", async ({
  page,
  baseURL,
  server,
}, testInfo) => {
  const tag = `B${testInfo.workerIndex}${testInfo.repeatEachIndex}${testInfo.retry}`;
  const { terminalId, tailMarker } = await setupLargeTerminal(page, baseURL, server.fixturePath, tag);

  await page.reload();
  const pane = await reconnectPane(page, terminalId);
  await expectTerminalBuffer(page, terminalId, { contains: tailMarker }, { timeout: WAIT_TIMEOUT_MS });
  const after = await snapshotOf(page, terminalId);
  expect(after.xterm.viewportY).toBe(after.xterm.baseY);

  // Scroll back, then return: the true bottom of the buffer must stay
  // reachable through the scrollbar's range.
  await wheel(page, pane, -1_000, 10);
  const up = await snapshotOf(page, terminalId);
  expect(up.xterm.viewportY).toBeLessThan(up.xterm.baseY);
  const down = await wheelToBottom(page, pane, terminalId);
  expect(down.xterm.viewportY).toBe(down.xterm.baseY);
});

test.describe("hidpi", () => {
  test.use({ deviceScaleFactor: 1.5, viewport: { width: 1280, height: 731 } });

  test("V-16 Renderer fallback keeps the bottom reachable @p1 @pr @nightly @scrollback @renderer", async ({
    page,
    baseURL,
    server,
  }, testInfo) => {
    const tag = `C${testInfo.workerIndex}${testInfo.repeatEachIndex}${testInfo.retry}`;
    const { pane, terminalId } = await setupLargeTerminal(page, baseURL, server.fixturePath, tag);
    const before = await snapshotOf(page, terminalId);
    test.skip(before.renderer !== "webgl", "WebGL renderer unavailable");

    // Scroll back first: the renderer swap and the grid re-election it causes
    // then happen away from the bottom, where a stale scroll range would strand
    // the user above the tail.
    await wheel(page, pane, -1_000, 10);
    const up = await snapshotOf(page, terminalId);
    expect(up.xterm.viewportY).toBeLessThan(up.xterm.baseY);

    await page.evaluate((id) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      api.controls.loseContext(id);
    }, terminalId);
    await page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      await api.waitForTerminal(id, (snapshot) => snapshot.renderer !== "webgl", { timeout });
    }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
    await waitSettled(page, terminalId);

    const down = await wheelToBottom(page, pane, terminalId);
    expect(down.xterm.viewportY).toBe(down.xterm.baseY);
  });
});

test("V-16 Hidden-pane synchronized output keeps the bottom reachable @p1 @pr @nightly @scrollback @renderer", async ({
  page,
  baseURL,
  server,
}, testInfo) => {
  const tag = `D${testInfo.workerIndex}${testInfo.repeatEachIndex}${testInfo.retry}`;
  const { pane, terminalId } = await setupLargeTerminal(page, baseURL, server.fixturePath, tag);

  // Queue a synchronized-output frame plus a large burst behind a hold. The
  // executor releases it later, while this pane is display:none with a paused
  // renderer: every byte parses, but xterm defers all scroll-range syncs
  // behind the open DECSET 2026 frame and no render ever flushes them.
  await pane.sendInput(`HOLD ${tag}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold", { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`SYNC_BEGIN ${tag}`, true);
  await pane.sendInput(`BURST ${tag}2 200000 80`, true);
  const hiddenMarker = `V16-HIDDEN-${tag}`;
  await pane.sendInput(`PRINT ${tag}-HIDDEN ${hiddenMarker}`, true);

  const second = await createFixtureTerminal(page, `v16-${tag}-other`, server.fixturePath);
  const workbench = new WorkbenchPage(page);
  const secondPane = await workbench.openTerminal({ id: second.id, name: second.name });
  await secondPane.expectVisible();
  await secondPane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => !snapshot.visible, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
  const beforeRelease = await snapshotOf(page, terminalId);

  // Release the held burst from a second client so the hidden pane receives
  // it without ever being shown.
  const releasePage = await page.context().newPage();
  try {
    await releasePage.goto(baseURL);
    const releaseWorkbench = new WorkbenchPage(releasePage);
    await releaseWorkbench.expectVisible();
    const releasePane = await releaseWorkbench.openTerminal({ id: terminalId, name: "" });
    await releasePane.expectVisible();
    await releasePane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    await releasePane.sendInput(`RELEASE ${tag}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === `${tag}-HIDDEN`,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
  } finally {
    await releasePage.close();
  }

  // Wait until the hidden pane has parsed the burst into its buffer.
  await page.evaluate(async ({ id, floor, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => (
      snapshot.xterm.bufferLength > floor
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
    ), { timeout });
  }, { id: terminalId, floor: beforeRelease.xterm.bufferLength + 2000, timeout: WAIT_TIMEOUT_MS });

  // Return to the pane and immediately try to reach the bottom, the way a
  // user flicks the wheel the moment they come back. Without the re-sync on
  // visibility restore bypassing the still-open synchronized-output frame,
  // the scroll range is frozen thousands of lines short and the request is
  // clamped and discarded.
  const restored = await workbench.openTerminal({ id: terminalId, name: "" });
  await restored.expectVisible();
  const box = await restored.xtermHost.boundingBox();
  if (!box) throw new Error("terminal host has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let tick = 0; tick < 30; tick += 1) {
    await page.mouse.wheel(0, 4_000);
  }
  await page.waitForTimeout(150);
  const after = await snapshotOf(page, terminalId);
  expect(after.xterm.viewportY).toBe(after.xterm.baseY);
});
