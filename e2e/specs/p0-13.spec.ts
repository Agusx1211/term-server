import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { Page } from "@playwright/test";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectSingleTerminalSocket,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { expectTerminalNonBlank } from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

const DIAGNOSTIC_TIMEOUT = 15_000;

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
      (event) => event.id > after && event.type === "viewport" && event.data.source === "sent",
      { timeout, afterId: after },
    );
  }, { id: terminalId, after: afterEventId, timeout: DIAGNOSTIC_TIMEOUT });
}

async function waitForServerViewport(
  page: Page,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, cols, rows, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => (
        snapshot.cols === cols
        && snapshot.rows === rows
        && snapshot.serverViewport?.cols === cols
        && snapshot.serverViewport?.rows === rows
      ),
      { timeout },
    );
  }, { id: terminalId, cols, rows, timeout: DIAGNOSTIC_TIMEOUT });
}

test("P0-13 WebGL initialization failure falls back @p0", async ({ page, baseURL, server }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const login = new LoginPage(page);
  await page.goto(baseURL);
  await login.login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  // Disable the cache so closing the first pane disposes its renderer. The
  // existing terminal remains in the sidebar and can be opened again after
  // the E2E renderer fault is installed.
  const settings = await workbench.openSettings();
  await settings.setCachedTerminalLimit(0);
  await workbench.closeSettings();
  await workbench.createTerminal();

  const region = page.locator(".editor-grid [data-terminal-id]").first();
  await expect(region).toBeVisible();
  const terminalId = await region.getAttribute("data-terminal-id");
  expect(terminalId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (!terminalId) throw new Error("created terminal did not expose a stable terminal ID");

  const firstPane = new TerminalPanePage(page, terminalId);
  await firstPane.expectVisible();
  const accessibleName = await firstPane.root.getAttribute("aria-label");
  const terminalName = accessibleName?.replace(/^Terminal\s+/, "");
  expect(terminalName).toBeTruthy();
  if (!terminalName) throw new Error("created terminal did not expose an accessible name");

  await firstPane.closePane();
  await expect(firstPane.root).toHaveCount(0);

  // Configure the fault while the pane is unmounted. The diagnostics seam
  // retains this terminal-scoped fault for the next real renderer load.
  await page.evaluate(({ id }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.renderer.failWebGL(id, { message: "P0-13 forced WebGL initialization failure" });
  }, { id: terminalId });

  const pane = await workbench.openTerminal({ id: terminalId, name: terminalName });
  await pane.expectVisible();

  const fallbackEvent = await pane.waitForEvent("renderer-fallback", { timeout: DIAGNOSTIC_TIMEOUT });
  expect(fallbackEvent.data.reason).toBe("load-failed");

  const synchronized = await expectTerminalSynchronized(page, terminalId, { timeout: DIAGNOSTIC_TIMEOUT });
  expect(synchronized.renderer).toBe("canvas");
  expect(synchronized.rendererState.kind).toBe("canvas");
  expect(synchronized.webglLoadCount).toBe(1);
  expect(synchronized.fallbackCount).toBe(1);
  expect(synchronized.contextLossCount).toBe(0);
  expect(synchronized.pendingParserWrites).toBe(0);

  const priorEvents = await pane.events();
  const lastEventId = priorEvents.at(-1)?.id ?? 0;

  // A real browser resize drives FitAddon and the production viewport path.
  await workbench.setViewport(900, 640);
  const sentViewportEvent = await waitForSentViewport(page, terminalId, lastEventId);
  const targetCols = Number(sentViewportEvent.data.cols);
  const targetRows = Number(sentViewportEvent.data.rows);
  expect(Number.isInteger(targetCols)).toBe(true);
  expect(Number.isInteger(targetRows)).toBe(true);
  expect(targetCols).toBeGreaterThan(0);
  expect(targetRows).toBeGreaterThan(0);
  await waitForServerViewport(page, terminalId, targetCols, targetRows);

  const resized = await expectTerminalConverged(page, terminalId, {
    cols: targetCols,
    rows: targetRows,
  }, { timeout: DIAGNOSTIC_TIMEOUT });
  expect(resized.serverViewport?.cols).toBe(targetCols);
  expect(resized.serverViewport?.rows).toBe(targetRows);
  expect(resized.pixelWidth).toBeGreaterThan(0);
  expect(resized.pixelHeight).toBeGreaterThan(0);

  const sizeMarker = "P013-SIZE";
  const sizeTranscript = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeMarker,
    { timeoutMs: DIAGNOSTIC_TIMEOUT },
  );
  await pane.sendInput(`SIZE ${sizeMarker}`, true);
  const sizeEntry = await sizeTranscript;
  expect(sizeEntry.rows).toBe(targetRows);
  expect(sizeEntry.cols).toBe(targetCols);
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:SIZE:${sizeMarker}:` }, { timeout: DIAGNOSTIC_TIMEOUT });

  const outputId = "P013-OUTPUT";
  const outputText = "P013-FALLBACK-OUTPUT";
  const printTranscript = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === outputId && entry.text === outputText,
    { timeoutMs: DIAGNOSTIC_TIMEOUT },
  );
  await pane.sendInput(`PRINT ${outputId} ${outputText}`, true);
  await printTranscript;
  await expectTerminalBuffer(
    page,
    terminalId,
    { contains: `[E2E:PRINT:${outputId}:${outputText}]` },
    { timeout: DIAGNOSTIC_TIMEOUT },
  );

  const inputId = "P013-INPUT";
  const inputMarker = "P013-CONTINUED-INPUT";
  const inputArmed = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "armed",
    { timeoutMs: DIAGNOSTIC_TIMEOUT },
  );
  await pane.sendInput(`ECHO_INPUT ${inputId}`, true);
  await inputArmed;

  const echoedInput = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload",
    { timeoutMs: DIAGNOSTIC_TIMEOUT },
  );
  await pane.sendInput(inputMarker, true);
  const echoedEntry = await echoedInput;
  expect(echoedEntry.bytes).toBe(inputMarker.length);
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:ECHO_INPUT:${inputId}:` }, { timeout: DIAGNOSTIC_TIMEOUT });

  const finalSnapshot = await expectTerminalInteractive(page, terminalId, { timeout: DIAGNOSTIC_TIMEOUT });
  expect(finalSnapshot.renderer).toBe("canvas");
  expect(finalSnapshot.fallbackCount).toBe(1);
  expect(finalSnapshot.cols).toBe(targetCols);
  expect(finalSnapshot.rows).toBe(targetRows);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-13-fallback-compositor",
  });

  await expectSingleTerminalSocket(page, terminalId, { timeout: DIAGNOSTIC_TIMEOUT });
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: DIAGNOSTIC_TIMEOUT });
  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "renderer-fallback")).toHaveLength(1);
  expect(events.some((event) => event.type === "renderer-load")).toBe(false);
  expect(events.some((event) => event.type === "error")).toBe(false);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors, "WebGL fallback produced an unhandled browser error").toEqual([]);
});
