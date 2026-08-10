import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { assertNoPendingSynchronization, expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
} from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

async function waitForRendererReady(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "renderer-load" || event.type === "renderer-fallback",
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

const WAIT_TIMEOUT_MS = 20_000;

const cssAttribute = (value: string): string => value.replace(/(["\\])/g, "\\$1");

async function visibleTerminalId(page: Page): Promise<string> {
  const slot = page.locator(".pane-slot:not(.cached)").first();
  await expect(slot).toHaveAttribute("data-terminal-id", /.+/);
  const id = await slot.getAttribute("data-terminal-id");
  if (!id) throw new Error("visible terminal pane has no terminal ID");
  return id;
}

async function terminalName(page: Page, terminalId: string): Promise<string> {
  const row = page.locator(`.sidebar .terminal-row[data-terminal-id="${cssAttribute(terminalId)}"]`);
  await expect(row).toHaveCount(1);
  const title = row.locator(".terminal-title");
  await expect(title).toHaveCount(1);
  await expect(title).toBeVisible();
  const name = (await title.innerText()).trim();
  if (!name) throw new Error("created terminal has no accessible name");
  return name;
}

async function diagnosticTerminal(page: Page, terminalId: string): Promise<unknown> {
  return page.evaluate((id) => {
    const api = (window as Window & {
      __TERM_SERVER_E2E__?: { terminal: (terminalId: string) => unknown };
    }).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id);
  }, terminalId);
}

test("P0-10 Cached pane eviction and recreation @p0", async ({
  page,
  server,
  faultController,
  baseURL,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const settings = await workbench.openSettings();
  await settings.setCachedTerminalLimit(1);
  await expect(settings.root.getByRole("slider", {
    name: "Terminals kept alive off screen",
    exact: true,
  })).toHaveValue("1");
  await workbench.closeSettings();
  await workbench.createTerminal();
  const cachedId = await visibleTerminalId(page);
  const initialName = await terminalName(page, cachedId);
  const cachedName = `P010-CACHE-${testInfo.workerIndex}-${testInfo.retry}`;
  await workbench.sidebar.renameTerminal({ id: cachedId, name: initialName }, cachedName);
  const cachedRow = page.locator(`.sidebar .terminal-row[data-terminal-id="${cssAttribute(cachedId)}"]`);
  await expect(cachedRow).toHaveCount(1);
  await expect(cachedRow.locator(".terminal-title")).toHaveText(cachedName);
  const cachedPane = new TerminalPanePage(page, cachedId);
  await cachedPane.expectVisible();
  const initial = await expectTerminalSynchronized(page, cachedId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);

  const cachedMarker = `P010-CACHED-${testInfo.workerIndex}-${testInfo.retry}`;
  await cachedPane.sendInput(`PRINT ${cachedMarker} ${cachedMarker}`, true);
  await server.waitForTranscript(cachedId, (entry) => (
    entry.event === "print" && entry.id === cachedMarker && entry.text === cachedMarker
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, cachedId, {
    contains: `[E2E:PRINT:${cachedMarker}:${cachedMarker}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, cachedPane.xtermHost, {
    testInfo,
    artifactName: "p0-10-before-eviction",
  });
  const beforeEviction = await screenshotRegion(page, cachedPane.xtermHost);
  const oldPaneSnapshot = await cachedPane.snapshot();
  if (!oldPaneSnapshot) throw new Error("missing diagnostics before cache eviction");
  const oldPaneId = oldPaneSnapshot.paneId;
  const socketClose = faultController.waitFor(
    (event) => event.terminalId === cachedId
      && (event.type === "connection-closed" || event.type === "connection-terminated"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const unmount = cachedPane.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const [, unmounted] = await Promise.all([socketClose, unmount]);
  expect(unmounted.type).toBe("unmount");
  expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
  expect(unmounted.snapshot.lifecycle.cached).toBe(true);
  expect(unmounted.snapshot.activeSocketCount).toBe(0);
  expect(unmounted.snapshot.socket.activeCount).toBe(0);

  const oldSlot = page.locator(`.pane-slot[data-terminal-id="${cssAttribute(cachedId)}"]`);
  await expect(oldSlot).toHaveCount(0);
  expect(await diagnosticTerminal(page, cachedId)).toBeUndefined();
  expect(await cachedPane.events()).toEqual([]);
  await expect(page.locator(".pane-slot:not(.cached)")).toHaveCount(1);
  const otherId = await visibleTerminalId(page);
  expect(otherId).not.toBe(cachedId);
  const otherPane = new TerminalPanePage(page, otherId);
  await otherPane.expectVisible();
  await expectTerminalSynchronized(page, otherId, { timeout: WAIT_TIMEOUT_MS });
  await expectConnectedTerminalInvariants(page, otherId, { timeout: WAIT_TIMEOUT_MS });

  const rendererReady = waitForRendererReady(page, cachedId);
  const restored = await workbench.openTerminal({ id: cachedId, name: cachedName });
  await restored.expectVisible();
  const [rendererEvent, restoredSnapshot] = await Promise.all([
    rendererReady,
    expectTerminalSynchronized(page, cachedId, { timeout: WAIT_TIMEOUT_MS }),
  ]);
  expect(["renderer-load", "renderer-fallback"]).toContain(rendererEvent.type);
  expect(rendererEvent.snapshot.lifecycle.mounted).toBe(true);
  expect(restoredSnapshot.paneId).toBe(oldPaneId);
  expect(restoredSnapshot.socketGeneration).toBe(1);
  expect(restoredSnapshot.lifecycle.mounted).toBe(true);
  expect(restoredSnapshot.lifecycle.visible).toBe(true);
  expect(restoredSnapshot.lifecycle.cached).toBe(false);
  const restoredCanvas = page.locator(`.pane-slot[data-terminal-id="${cssAttribute(cachedId)}"] canvas`).first();
  await expect(restoredCanvas).toBeAttached();

  const restoredEvents = await restored.events();
  expect(restoredEvents[0]?.type).toBe("mount");
  expect(restoredEvents.filter((event) => event.type === "renderer-load" || event.type === "renderer-fallback")).toHaveLength(1);

  expect(restoredEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(restoredEvents.some((event) => event.type === "socket-stale")).toBe(false);
  const recoveryModes = restoredEvents.flatMap((event) => {
    const mode = event.snapshot.syncMode;
    return mode === "resume" || mode === "snapshot" ? [mode] : [];
  });
  expect(recoveryModes.length).toBeGreaterThan(0);
  expect(recoveryModes.every((mode) => mode === "resume" || mode === "snapshot")).toBe(true);
  await expectTerminalBuffer(page, cachedId, {
    contains: `[E2E:PRINT:${cachedMarker}:${cachedMarker}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const restoredMarker = `P010-RESTORED-${testInfo.workerIndex}-${testInfo.retry}`;
  await restored.sendInput(`PRINT ${restoredMarker} ${restoredMarker}`, true);
  await server.waitForTranscript(cachedId, (entry) => (
    entry.event === "print" && entry.id === restoredMarker && entry.text === restoredMarker
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, cachedId, {
    contains: `[E2E:PRINT:${restoredMarker}:${restoredMarker}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, restored.xtermHost, {
    testInfo,
    artifactName: "p0-10-after-recreation",
  });
  const afterRecreation = await screenshotRegion(page, restored.xtermHost);
  await expectTerminalPixelsChanged(beforeEviction, afterRecreation, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-10-recreation-changed-pixels",
  });
  const postRenderSnapshot = await restored.snapshot();
  if (!postRenderSnapshot) throw new Error("missing diagnostics after recreated render");
  expect(postRenderSnapshot.rendererState.renderCount).toBeGreaterThan(0);

  await expectTerminalConverged(page, cachedId, {
    cols: initial.cols,
    rows: initial.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectConnectedTerminalInvariants(page, cachedId, { timeout: WAIT_TIMEOUT_MS });
  const settled = await restored.snapshot();
  if (!settled) throw new Error("missing diagnostics after cache recreation");
  assertNoPendingSynchronization(settled);

  const inputId = `P010-ECHO-${testInfo.workerIndex}-${testInfo.retry}`;
  const inputPayload = `input-${testInfo.workerIndex}-${testInfo.retry}`;
  await restored.sendInput(`ECHO_INPUT ${inputId} ${inputPayload}`, true);
  const echo = await server.waitForTranscript(cachedId, (entry) => (
    entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(echo.text).toBe(inputPayload);
  await expectTerminalBuffer(page, cachedId, {
    contains: `[E2E:ECHO_INPUT:${inputId}:`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const finalSettled = await restored.snapshot();
  if (!finalSettled) throw new Error("missing diagnostics after continued input");
  assertNoPendingSynchronization(finalSettled);
  const transcript = await server.readTranscript(cachedId);
  const echoes = transcript.filter((entry) => (
    entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload"
  ));
  expect(echoes).toHaveLength(1);

  const finalEvents = await restored.events();
  expect(finalEvents.some((event) => event.type === "error")).toBe(false);
  await expectConnectedTerminalInvariants(page, cachedId, { timeout: WAIT_TIMEOUT_MS });
  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
