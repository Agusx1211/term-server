import { Buffer } from "node:buffer";
import { expect, test } from "../fixtures/test.js";
import type { IsolatedServer } from "../fixtures/test.js";
import { assertNoPendingSynchronization, expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { assertMonotonicSequences } from "../assertions/terminal-state.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { Page } from "@playwright/test";

const MOBILE_VIEWPORT = { width: 800, height: 900 };
const WAIT_TIMEOUT = 15_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
  __TERM_SERVER_CONTEXT_MENU_SEEN__?: boolean;
};

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function marker(operation: string, id: string): string {
  return `[E2E:${operation}:${id}]`;
}

async function waitForMarkers(
  page: Page,
  terminalId: string,
  values: readonly string[],
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, values: expected }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => expected.every((value) => snapshot.xterm.text.includes(value)),
      { timeout: 15_000 },
    );
  }, { id: terminalId, values });
}

async function waitForSelection(
  page: Page,
  terminalId: string,
  selectedText: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, selectedText: expected }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.selectionText === expected,
      { timeout: 15_000 },
    );
  }, { id: terminalId, selectedText });
}

async function waitForInteractive(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.socketState === "connected" && snapshot.acceptingInput,
      { timeout: 15_000 },
    );
  }, terminalId);
}

async function commandOracle(server: IsolatedServer, terminalId: string): Promise<readonly [unknown, unknown][]> {
  const entries = await server.readTranscript(terminalId);
  return entries
    .filter((entry) => entry.event === "command")
    .map((entry) => [entry.operation, entry.command_base64] as const);
}

async function sendFixtureCommand(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  command: string,
  operation: string,
): Promise<void> {
  const expectedBase64 = base64(command);
  await pane.sendInput(command, true);
  const entry = await server.waitForTranscript(
    terminalId,
    (candidate: Record<string, unknown>) => (
      candidate.event === "command"
      && candidate.operation === operation
      && candidate.command_base64 === expectedBase64
    ),
    { timeoutMs: WAIT_TIMEOUT },
  ) as Record<string, unknown>;
  expect(entry.command_base64).toBe(expectedBase64);
  // The fixture records the parsed command without its line delimiter. The
  // delimiter is the keyboard Enter byte that caused the command event.
  expect(`${Buffer.from(String(entry.command_base64), "base64").toString("utf8")}\r`).toBe(`${command}\r`);
}

async function selectMarker(
  pane: TerminalPanePage,
  snapshot: E2ETerminalSnapshot,
  selectedText: string,
): Promise<void> {
  const lines = snapshot.xterm.text.split("\n");
  const lineIndex = lines.findIndex((line) => line.includes(selectedText));
  if (lineIndex < 0) throw new Error(`Unable to locate ${selectedText} in the terminal model`);
  const column = lines[lineIndex]!.indexOf(selectedText);
  const visualRow = lineIndex - snapshot.viewportY;
  if (visualRow < 0 || visualRow >= snapshot.rows) {
    throw new Error(`Selection marker ${selectedText} is outside the visible terminal viewport`);
  }

  const screen = pane.xtermHost.locator(".xterm-screen");
  const box = await screen.boundingBox();
  if (!box || snapshot.cols <= 0 || snapshot.rows <= 0) {
    throw new Error("Terminal screen geometry is unavailable for selection");
  }
  const cellWidth = box.width / snapshot.cols;
  const cellHeight = box.height / snapshot.rows;
  const y = box.y + (visualRow + 0.5) * cellHeight;
  const startX = box.x + (column + 0.25) * cellWidth;
  const endX = box.x + (column + selectedText.length - 0.25) * cellWidth;
  await pane.page.mouse.move(startX, y);
  await pane.page.mouse.down();
  await pane.page.mouse.move(endX, y);
  await pane.page.mouse.up();
}

async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    if (!navigator.clipboard?.readText) throw new Error("navigator.clipboard.readText is unavailable");
    return navigator.clipboard.readText();
  });
}

async function setClipboard(page: Page, value: string): Promise<void> {
  await page.evaluate(async (text) => {
    if (!navigator.clipboard?.writeText) throw new Error("navigator.clipboard.writeText is unavailable");
    await navigator.clipboard.writeText(text);
  }, value);
}

test("I-06 Copy and selection survives ordinary output @nightly @input @clipboard @selection", async ({ page, browser, server }, testInfo) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.openMobileSidebar();
  await workbench.expectVisible();

  await workbench.createTerminal();
  const region = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(region).toBeVisible();
  const terminalId = await region.getAttribute("data-terminal-id");
  const terminalName = (await region.getAttribute("aria-label"))?.replace(/^Terminal\s+/i, "");
  if (!terminalId || !terminalName) throw new Error("Created terminal did not expose a stable identity");

  const pane = new TerminalPanePage(page, terminalId, terminalName);
  await pane.expectVisible();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT });
  const initial = await waitForInteractive(page, terminalId);
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.syncMode).toBeUndefined();
  expect(initial.pendingParserWrites).toBe(0);

  const beforeOutput = await screenshotRegion(page, pane.xtermHost);
  const readyCommand = "READY I06";
  const oneCommand = "PRINT I06-ONE";
  const twoCommand = "PRINT I06-TWO";
  const afterCommand = "PRINT I06_AFTER";
  const continuedCommand = "ECHO_INPUT I06_CONTINUED ALIVE";
  const oneMarker = marker("PRINT", "I06-ONE");
  const twoMarker = marker("PRINT", "I06-TWO");
  const afterMarker = marker("PRINT", "I06_AFTER");
  const continuedMarker = marker("ECHO_INPUT", "I06_CONTINUED");

  await sendFixtureCommand(pane, server, terminalId, readyCommand, "READY");
  await server.waitForTranscript(
    terminalId,
    (entry: Record<string, unknown>) => entry.event === "ready" && entry.id === "I06",
    { timeoutMs: WAIT_TIMEOUT },
  );
  await sendFixtureCommand(pane, server, terminalId, oneCommand, "PRINT");
  await server.waitForTranscript(
    terminalId,
    (entry: Record<string, unknown>) => entry.event === "print" && entry.id === "I06-ONE",
    { timeoutMs: WAIT_TIMEOUT },
  );
  await waitForMarkers(page, terminalId, [oneMarker]);
  await sendFixtureCommand(pane, server, terminalId, twoCommand, "PRINT");
  await server.waitForTranscript(
    terminalId,
    (entry: Record<string, unknown>) => entry.event === "print" && entry.id === "I06-TWO",
    { timeoutMs: WAIT_TIMEOUT },
  );
  await waitForMarkers(page, terminalId, [oneMarker, twoMarker]);
  const afterPrints = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeOutput, afterPrints, { minimumChangedRatio: 0.002 });
  await expectTerminalNonBlank(page, pane.xtermHost, { minimumNonBackgroundRatio: 0.002 });

  // A second authenticated production client drives ordinary output while the
  // first pane keeps its xterm selection active. This avoids turning the
  // selection-survival check into a user-input (and selection-clearing) test.
  const peerContext = await browser.newContext({
    baseURL: server.baseURL,
    viewport: MOBILE_VIEWPORT,
  });
  const peerPage = await peerContext.newPage();
  const peerErrors: Error[] = [];
  peerPage.on("pageerror", (error) => peerErrors.push(error));
  try {
    await peerPage.goto("/");
    await new LoginPage(peerPage).login();
    const peerWorkbench = new WorkbenchPage(peerPage);
    await peerWorkbench.expectVisible();
    await peerWorkbench.openTerminal(terminalName);
    const peerPane = new TerminalPanePage(peerPage, terminalId, terminalName);
    await peerPane.expectVisible();
    await peerPane.waitForSynchronized({ timeout: WAIT_TIMEOUT });
    const beforeSelectionOutput = await screenshotRegion(page, pane.xtermHost);
    const selectionModel = await pane.snapshot();
    if (!selectionModel) throw new Error("Missing terminal diagnostics before selection");
    await selectMarker(pane, selectionModel, "I06-ONE");

    await peerPage.bringToFront();
    await sendFixtureCommand(peerPane, server, terminalId, afterCommand, "PRINT");
    await server.waitForTranscript(
      terminalId,
      (entry: Record<string, unknown>) => entry.event === "print" && entry.id === "I06_AFTER",
      { timeoutMs: WAIT_TIMEOUT },
    );
    await waitForMarkers(page, terminalId, [afterMarker]);
    const selected = await waitForSelection(page, terminalId, "I06-ONE");
    expect(selected.selectionText).toBe("I06-ONE");
    expect(selected.xterm.text).toContain(oneMarker);
    expect(selected.xterm.text).toContain(twoMarker);
    expect(selected.xterm.text).toContain(afterMarker);
    const afterOrdinaryOutput = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalPixelsChanged(beforeSelectionOutput, afterOrdinaryOutput, { minimumChangedRatio: 0.002 });
    await expectTerminalNonBlank(page, pane.xtermHost, { minimumNonBackgroundRatio: 0.002 });

    // Right-click is a browser context-menu path, not the terminal actions menu.
    // Capture the DOM event and suppress the native UI so Playwright remains in
    // control; there must be no application menu created by this gesture.
    await page.bringToFront();
    await page.evaluate(() => {
      const target = window as E2EWindow;
      target.__TERM_SERVER_CONTEXT_MENU_SEEN__ = false;
      document.addEventListener("contextmenu", (event) => {
        target.__TERM_SERVER_CONTEXT_MENU_SEEN__ = true;
        event.preventDefault();
      }, { capture: true, once: true });
    });
    await pane.xtermHost.click({ button: "right" });
    const contextMenuSeen = await page.evaluate(() => (window as E2EWindow).__TERM_SERVER_CONTEXT_MENU_SEEN__ === true);
    if (contextMenuSeen) {
      await expect(pane.root.getByRole("menu")).toHaveCount(0);
      expect((await pane.snapshot())?.selectionText).toBe("I06-ONE");
    } else {
      testInfo.annotations.push({
        type: "capability",
        description: "The selected browser engine did not expose a DOM contextmenu event; the native context menu branch is not inspectable.",
      });
    }

    const commandOracleBeforeCopy = await commandOracle(server, terminalId);
    const clipboardApiAvailable = await page.evaluate(() => (
      typeof navigator.clipboard?.readText === "function"
      && typeof navigator.clipboard?.writeText === "function"
    ));
    let clipboardReady = clipboardApiAvailable;
    if (clipboardApiAvailable) {
      try {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(server.baseURL).origin,
        });
      } catch (error) {
        clipboardReady = false;
        testInfo.annotations.push({
          type: "capability",
          description: `Clipboard permission grant was unavailable in this browser context: ${String(error)}`,
        });
      }
    } else {
      testInfo.annotations.push({
        type: "capability",
        description: "navigator.clipboard read/write is unavailable; native clipboard bytes cannot be read in this browser.",
      });
    }

    const copyKeyboard = async (key: string): Promise<void> => {
      if (clipboardReady) await setClipboard(page, `I06-copy-sentinel-${key.replace(/[^A-Za-z0-9]+/g, "-")}`);
      await page.bringToFront();
      await page.keyboard.press(key);
      if (clipboardReady) expect(await clipboardText(page)).toBe("I06-ONE");
      expect((await pane.snapshot())?.selectionText).toBe("I06-ONE");
      expect(await commandOracle(server, terminalId)).toEqual(commandOracleBeforeCopy);
    };

    const isMac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform));
    if (isMac) {
      await copyKeyboard("Meta+C");
    } else {
      await copyKeyboard("Control+Shift+C");
      await copyKeyboard("Control+Insert");
    }

    const actionsButton = pane.root.getByRole("button", { name: "Terminal actions", exact: true });
    if (await actionsButton.isVisible()) {
      if (clipboardReady) await setClipboard(page, "I06-copy-sentinel-menu");
      await pane.openActions();
      await pane.root.getByRole("menuitem", { name: "Copy selection", exact: true }).click();
      const expectedNotice = clipboardReady
        ? "Copied selection"
        : clipboardApiAvailable
          ? "Clipboard permission was denied"
          : "Clipboard access requires HTTPS or localhost";
      await expect(page.getByRole("status", { name: expectedNotice, exact: true })).toHaveText(expectedNotice);
      if (clipboardReady) expect(await clipboardText(page)).toBe("I06-ONE");
      expect((await pane.snapshot())?.selectionText).toBe("I06-ONE");
      expect(await commandOracle(server, terminalId)).toEqual(commandOracleBeforeCopy);
    } else {
      testInfo.annotations.push({
        type: "capability",
        description: "The configured viewport did not expose the mobile terminal actions menu; keyboard copy paths remain covered.",
      });
    }
  } finally {
    await peerContext.close();
  }

  await page.bringToFront();
  let final = await pane.snapshot();
  if (!final?.acceptingInput) {
    await pane.focus();
    final = await waitForInteractive(page, terminalId);
  }
  await sendFixtureCommand(pane, server, terminalId, continuedCommand, "ECHO_INPUT");
  await server.waitForTranscript(
    terminalId,
    (entry: Record<string, unknown>) => entry.event === "echo_input" && entry.id === "I06_CONTINUED" && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT },
  );
  await waitForMarkers(page, terminalId, [afterMarker, continuedMarker]);

  const finalCrop = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, { minimumNonBackgroundRatio: 0.002 });
  const finalReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT });
  final = finalReport.snapshot;
  await assertMonotonicSequences(finalReport.events);
  assertNoPendingSynchronization(final);
  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  expect(final.syncMode).toBeUndefined();
  expect(final.serverViewport).toMatchObject({ cols: final.cols, rows: final.rows });
  expect(final.viewport.cols).toBe(final.cols);
  expect(final.viewport.rows).toBe(final.rows);
  expect(final.xterm.text).toContain(oneMarker);
  expect(final.xterm.text).toContain(twoMarker);
  expect(final.xterm.text).toContain(afterMarker);
  expect(final.xterm.text).toContain(continuedMarker);
  expect(pageErrors).toEqual([]);
  expect(peerErrors).toEqual([]);

  const entries = await server.readTranscript(terminalId);
  const expectedCommands = [
    ["READY", base64(readyCommand)],
    ["PRINT", base64(oneCommand)],
    ["PRINT", base64(twoCommand)],
    ["PRINT", base64(afterCommand)],
    ["ECHO_INPUT", base64(continuedCommand)],
  ];
  expect(entries.filter((entry) => entry.event === "error")).toEqual([]);
  expect(entries.filter((entry) => entry.event === "ready" && entry.id === "I06")).toHaveLength(1);
  expect(entries.filter((entry) => entry.event === "print" && entry.id === "I06-ONE")).toHaveLength(1);
  expect(entries.filter((entry) => entry.event === "print" && entry.id === "I06-TWO")).toHaveLength(1);
  expect(entries.filter((entry) => entry.event === "print" && entry.id === "I06_AFTER")).toHaveLength(1);
  expect(entries.filter((entry) => entry.event === "echo_input" && entry.id === "I06_CONTINUED" && entry.phase === "payload")).toHaveLength(1);
  expect(await commandOracle(server, terminalId)).toEqual(expectedCommands);
  expect(server.stderr).not.toMatch(/panicked|thread '.*' panicked/i);
});
