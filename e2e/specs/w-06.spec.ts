import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  expectTerminalBuffer,
  expectTerminalConnected,
  expectTerminalInteractive,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
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
const BURST_BYTES = 32_768;
const BURST_LINE_WIDTH = 96;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
  readonly clients: number;
}

interface CreatedTerminal extends TerminalApiInfo {
  readonly name: string;
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo | undefined> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    return terminals.find((terminal) => terminal.id === id);
  }, terminalId);
}

async function createNamedTerminal(
  page: Page,
  workbench: WorkbenchPage,
  name: string,
): Promise<CreatedTerminal> {
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

  const renameResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "PATCH"
      && url.pathname === `/api/terminals/${created.id}`;
  });
  await workbench.sidebar.renameTerminal({ id: created.id, name: created.name }, name);
  const renameResponse = await renameResponsePromise;
  expect(renameResponse.ok()).toBe(true);
  const renamed = await renameResponse.json() as TerminalApiInfo;
  expect(renamed.id).toBe(created.id);
  expect(renamed.name).toBe(name);
  return { ...created, ...renamed, name };
}

async function waitForDisconnected(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "state"
        && event.data.state === "disconnected"
        && event.snapshot.socketState === "disconnected"
        && event.snapshot.activeSocketCount === 0,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

function expectSameViewport(before: E2ETerminalSnapshot, after: E2ETerminalSnapshot): void {
  expect(after.cols).toBe(before.cols);
  expect(after.rows).toBe(before.rows);
  expect(after.pixelWidth).toBe(before.pixelWidth);
  expect(after.pixelHeight).toBe(before.pixelHeight);
  expect(after.serverViewport?.cols).toBe(before.serverViewport?.cols);
  expect(after.serverViewport?.rows).toBe(before.serverViewport?.rows);
  expect(after.serverViewport?.pixelWidth).toBe(before.serverViewport?.pixelWidth);
  expect(after.serverViewport?.pixelHeight).toBe(before.serverViewport?.pixelHeight);
}

function terminalUpgradeCount(
  faultController: { readonly events: readonly { readonly type: string; readonly terminalId?: string }[] },
  terminalId: string,
): number {
  return faultController.events.filter((event) => (
    event.type === "upgrade-request" && event.terminalId === terminalId
  )).length;
}

test("W-06 Close active terminal @p1 @chromium-pr @close @nightly", async ({
  page,
  server,
  faultController,
  baseURL,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `W06-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalAName = `${runTag}-A`;
  const terminalBName = `${runTag}-B`;
  const burstId = `${runTag}-BURST`;
  const holdToken = `${runTag}-CLOSE-HOLD`;
  const bPrintId = `${runTag}-B-AFTER-CLOSE`;
  const bPrintText = `${runTag}-B-AFTER-CLOSE-TEXT`;
  const bEchoId = `${runTag}-B-ECHO`;
  const bInput = `${runTag}-B-CONTINUED-INPUT`;
  const reopenedPrintId = `${runTag}-A-REOPENED`;
  const reopenedPrintText = `${runTag}-A-REOPENED-TEXT`;
  const reopenedEchoId = `${runTag}-A-ECHO`;
  const reopenedInput = `${runTag}-A-CONTINUED-INPUT`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const settings = await workbench.openSettings();
  await settings.setToggle("Tile new terminals", false);
  await settings.setCachedTerminalLimit(0);
  await expect(settings.root.getByRole("slider", {
    name: "Terminals kept alive off screen",
    exact: true,
  })).toHaveValue("0");
  await workbench.showTerminals();

  const terminalA = await createNamedTerminal(page, workbench, terminalAName);
  const terminalB = await createNamedTerminal(page, workbench, terminalBName);
  const aId = terminalA.id;
  const bId = terminalB.id;

  await workbench.openTerminal({ id: aId, name: terminalAName });
  await workbench.sidebar.splitTerminal({ id: bId, name: terminalBName });
  const paneA = new TerminalPanePage(page, aId);
  const paneB = new TerminalPanePage(page, bId);
  await paneA.expectVisible();
  await paneB.expectVisible();
  expect(await workbench.visiblePaneCount()).toBe(2);
  expect(await workbench.mountedPaneCount()).toBe(2);

  await paneA.focus();
  const initialA = await waitForTerminalState(page, aId, {
    socketState: "connected",
    activeSocketCount: 1,
    active: true,
    acceptingInput: true,
    pendingParserWrites: 0,
    renderBacklogBytes: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expect(paneA.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  const initialB = await waitForTerminalState(page, bId, {
    socketState: "connected",
    activeSocketCount: 1,
    pendingParserWrites: 0,
    renderBacklogBytes: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(initialA.serverViewport).toBeDefined();
  expect(initialB.serverViewport).toBeDefined();
  expect(initialA.active).toBe(true);
  expect(initialB.active).toBe(false);
  expect(initialB.focused).toBe(false);
  await expectTerminalInvariants(page, aId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalInvariants(page, bId, { timeout: WAIT_TIMEOUT_MS });

  const listedA = await readTerminal(page, aId);
  expect(listedA?.id).toBe(aId);
  expect(listedA?.status).toBe("running");
  expect(listedA?.pid).toEqual(expect.any(Number));
  const aPid = listedA?.pid;
  if (aPid === undefined || aPid === null) throw new Error(`terminal ${aId} did not expose a running fixture PID`);

  const aUpgradeCountBeforeClose = terminalUpgradeCount(faultController, aId);
  expect(aUpgradeCountBeforeClose).toBe(1);

  const pauseRule = faultController.pause("server-to-browser", { terminalId: aId });
  await faultController.waitFor(
    (event) => event.type === "paused" && event.terminalId === aId && event.direction === "server-to-browser",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const burstWrittenPromise = server.waitForTranscript(
    aId,
    (entry) => entry.event === "write" && entry.bytes === BURST_BYTES,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const burstPromise = server.waitForTranscript(
    aId,
    (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await paneA.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
  await Promise.all([burstPromise, burstWrittenPromise]);
  await paneA.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(
    aId,
    (entry) => entry.event === "hold" && entry.token === holdToken,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const beforeClose = await paneA.snapshot();
  if (!beforeClose) throw new Error(`No diagnostics snapshot for terminal ${aId} before close`);
  expect(beforeClose.socketState).toBe("connected");
  expect(beforeClose.activeSocketCount).toBe(1);
  expect(beforeClose.acceptingInput).toBe(true);
  expect(beforeClose.socketGeneration).toBe(initialA.socketGeneration);

  const socketClosePromise = paneA.waitForEvent("socket-close", { timeout: WAIT_TIMEOUT_MS });
  const disconnectedPromise = waitForDisconnected(page, aId);
  const connectionClosedPromise = faultController.waitFor(
    (event) => event.terminalId === aId
      && (event.type === "connection-closed" || event.type === "connection-terminated"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const unmountPromise = paneA.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
  const bFocusPromise = waitForTerminalState(page, bId, {
    socketState: "connected",
    activeSocketCount: 1,
    active: true,
    acceptingInput: true,
    pendingParserWrites: 0,
    renderBacklogBytes: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  await paneA.closePane();
  const [socketClose, disconnected, connectionClosed, unmounted, focusedB] = await Promise.all([
    socketClosePromise,
    disconnectedPromise,
    connectionClosedPromise,
    unmountPromise,
    bFocusPromise,
  ]);
  await expect(paneB.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  pauseRule.dispose();
  expect(connectionClosed.terminalId).toBe(aId);
  expect(socketClose.data.generation).toBe(beforeClose.socketGeneration);
  expect(disconnected.snapshot.socketState).toBe("disconnected");
  expect(disconnected.snapshot.activeSocketCount).toBe(0);
  expect(disconnected.snapshot.acceptingInput).toBe(false);
  expect(unmounted.type).toBe("unmount");
  expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
  expect(unmounted.snapshot.lifecycle.visible).toBe(false);
  expect(unmounted.snapshot.lifecycle.cached).toBe(true);
  expect(unmounted.snapshot.lifecycle.active).toBe(false);
  expect(unmounted.snapshot.lifecycle.focused).toBe(false);
  expect(unmounted.snapshot.lifecycle.acceptingInput).toBe(false);
  expect(unmounted.snapshot.activeSocketCount).toBe(0);
  expect(unmounted.snapshot.socket.activeCount).toBe(0);
  expect(unmounted.snapshot.socketGeneration).toBe(beforeClose.socketGeneration);
  expect(await paneA.snapshot()).toBeUndefined();
  expect(await paneA.events()).toEqual([]);
  await expect(paneA.root).toHaveCount(0);
  await expect(page.locator(`[data-terminal-id="${aId.replace(/(["\\])/g, "\\$1")}"]`)).toHaveCount(0);
  expect(await workbench.terminalPaneIds()).toEqual([bId]);
  expect(await workbench.visiblePaneCount()).toBe(1);
  expect(await workbench.mountedPaneCount()).toBe(1);
  expect(focusedB.active).toBe(true);
  expect(focusedB.acceptingInput).toBe(true);
  expectSameViewport(initialB, focusedB);

  const listedAfterClose = await readTerminal(page, aId);
  expect(listedAfterClose?.id).toBe(aId);
  expect(listedAfterClose?.status).toBe("running");
  expect(listedAfterClose?.pid).toBe(aPid);
  expect(listedAfterClose?.clients).toBe(0);
  expect(terminalUpgradeCount(faultController, aId)).toBe(aUpgradeCountBeforeClose);

  const bViewport = paneB.xtermHost.locator(".xterm-screen");
  const bBeforePrintPixels = await screenshotRegion(page, bViewport);
  await paneB.sendInput(`PRINT ${bPrintId} ${bPrintText}`, true);
  await server.waitForTranscript(
    bId,
    (entry) => entry.event === "print" && entry.id === bPrintId && entry.text === bPrintText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, bId, {
    contains: `[E2E:PRINT:${bPrintId}:${bPrintText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, bViewport, bBeforePrintPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "w-06-successor-marker-crop",
  });
  await expectTerminalNonBlank(page, bViewport, {
    testInfo,
    artifactName: "w-06-successor-terminal-crop",
  });

  await paneB.sendInput(`ECHO_INPUT ${bEchoId}`, true);
  await server.waitForTranscript(
    bId,
    (entry) => entry.event === "echo_input" && entry.id === bEchoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await paneB.sendInput(bInput, true);
  const bEcho = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    bId,
    (entry) => entry.event === "echo_input"
      && entry.id === bEchoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(bInput, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(bEcho.payload_base64).toBe(Buffer.from(bInput, "utf8").toString("base64"));
  await expect(paneB.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  const bAfterClose = await terminalSnapshot(page, bId);
  if (!bAfterClose) throw new Error(`No diagnostics snapshot for successor terminal ${bId}`);
  expect(bAfterClose.active).toBe(true);
  expect(bAfterClose.acceptingInput).toBe(true);
  expect(bAfterClose.activeSocketCount).toBe(1);
  expectSameViewport(initialB, bAfterClose);

  const upgradeCountBeforeReopen = terminalUpgradeCount(faultController, aId);
  const remountPromise = page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.type === "mount", { timeout });
  }, { id: aId, timeout: WAIT_TIMEOUT_MS });
  const reopenedPane = await workbench.sidebar.openTerminal({ id: aId, name: terminalAName });
  const remounted = await remountPromise;
  expect(remounted.type).toBe("mount");
  await reopenedPane.expectVisible();
  const reopened = await expectTerminalConnected(page, aId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalInteractive(page, aId, { timeout: WAIT_TIMEOUT_MS });
  expect(reopened.activeSocketCount).toBe(1);
  expect(reopened.socketState).toBe("connected");
  expect(reopened.socketGeneration).toBe(1);
  expect(terminalUpgradeCount(faultController, aId)).toBe(upgradeCountBeforeReopen + 1);

  await reopenedPane.sendInput(`RELEASE ${holdToken}`, true);
  await server.waitForTranscript(
    aId,
    (entry) => entry.event === "release" && entry.token === holdToken,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const reopenedViewport = reopenedPane.xtermHost.locator(".xterm-screen");
  const reopenedBeforePrintPixels = await screenshotRegion(page, reopenedViewport);
  await reopenedPane.sendInput(`PRINT ${reopenedPrintId} ${reopenedPrintText}`, true);
  await server.waitForTranscript(
    aId,
    (entry) => entry.event === "print" && entry.id === reopenedPrintId && entry.text === reopenedPrintText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, aId, {
    contains: `[E2E:PRINT:${reopenedPrintId}:${reopenedPrintText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, reopenedViewport, reopenedBeforePrintPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "w-06-reopened-marker-crop",
  });
  await expectTerminalNonBlank(page, reopenedViewport, {
    testInfo,
    artifactName: "w-06-reopened-terminal-crop",
  });

  await reopenedPane.sendInput(`ECHO_INPUT ${reopenedEchoId}`, true);
  await server.waitForTranscript(
    aId,
    (entry) => entry.event === "echo_input" && entry.id === reopenedEchoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await reopenedPane.sendInput(reopenedInput, true);
  const reopenedEcho = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    aId,
    (entry) => entry.event === "echo_input"
      && entry.id === reopenedEchoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(reopenedInput, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(reopenedEcho.payload_base64).toBe(Buffer.from(reopenedInput, "utf8").toString("base64"));

  const listedAfterReopen = await readTerminal(page, aId);
  expect(listedAfterReopen?.id).toBe(aId);
  expect(listedAfterReopen?.status).toBe("running");
  expect(listedAfterReopen?.pid).toBe(aPid);
  expect(listedAfterReopen?.clients).toBe(1);
  const aFinal = await expectTerminalInvariants(page, aId, { timeout: WAIT_TIMEOUT_MS });
  expect(aFinal.snapshot.socketState).toBe("connected");
  expect(aFinal.snapshot.activeSocketCount).toBe(1);
  expect(aFinal.snapshot.acceptingInput).toBe(true);
  expect(aFinal.violations).toEqual([]);
  const bFinal = await expectTerminalInvariants(page, bId, { timeout: WAIT_TIMEOUT_MS });
  expect(bFinal.violations).toEqual([]);

  const aTranscript = await server.readTranscript(aId);
  expect(aTranscript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
  expect(aTranscript.filter((entry) => entry.event === "hold" && entry.token === holdToken)).toHaveLength(1);
  expect(aTranscript.filter((entry) => entry.event === "release" && entry.token === holdToken)).toHaveLength(1);
  expect(aTranscript.filter((entry) => entry.event === "print" && entry.id === reopenedPrintId)).toHaveLength(1);
  expect(aTranscript.filter((entry) => entry.event === "echo_input" && entry.id === reopenedEchoId && entry.phase === "payload")).toHaveLength(1);
  expect(aTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
  const bTranscript = await server.readTranscript(bId);
  expect(bTranscript.filter((entry) => entry.event === "print" && entry.id === bPrintId)).toHaveLength(1);
  expect(bTranscript.filter((entry) => entry.event === "echo_input" && entry.id === bEchoId && entry.phase === "payload")).toHaveLength(1);
  expect(bTranscript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(await terminalEvents(page, bId)).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "error" }),
  ]));
  expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
  expect(browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ))).toEqual([]);
  browserErrors.dispose();
});
