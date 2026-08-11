import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultController, NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import LoginPage from "../pages/login-page.js";
import SettingsPage from "../pages/settings-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_SCROLLBACK_STORAGE_KEY } from "../../src/client/lib/terminal-scrollback.js";

const WAIT_TIMEOUT_MS = 45_000;
const VIEWPORT = { width: 1_280, height: 800 } as const;
const SCROLLBACK_OVERRIDE = 1_000;
const BURST_BYTES = 512 * 1024;
const BURST_LINE_WIDTH = 80;

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

interface ClientConfigResponse {
  readonly scrollbackLines: number;
}

interface ResourceCounts {
  readonly paneSlots: number;
  readonly terminalNodes: number;
  readonly canvasCount: number;
}

interface RendererRecreation {
  readonly oldSnapshot: E2ETerminalSnapshot;
  readonly oldUnmount: E2ETerminalEvent;
  readonly newMount: E2ETerminalEvent;
  readonly current: E2ETerminalSnapshot;
  readonly oldClose: NetworkFaultEvent;
  readonly newOpen: NetworkFaultEvent;
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} is missing from the server listing`);
    return terminal;
  }, terminalId);
}

async function readClientConfig(page: Page): Promise<ClientConfigResponse> {
  return page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`config request failed with HTTP ${response.status}`);
    const config = await response.json() as Partial<ClientConfigResponse>;
    const lines = config.scrollbackLines;
    if (typeof lines !== "number" || !Number.isSafeInteger(lines)) {
      throw new Error("config has no safe scrollback line count");
    }
    return { scrollbackLines: lines };
  });
}

async function readResources(page: Page): Promise<ResourceCounts> {
  return page.evaluate(() => {
    const paneSlots = [...document.querySelectorAll("main.editor-grid .pane-slot")];
    return {
      paneSlots: paneSlots.length,
      terminalNodes: paneSlots.reduce((count, slot) => count + slot.querySelectorAll("[data-terminal-id]").length, 0),
      canvasCount: document.querySelectorAll("main.editor-grid .xterm-host canvas").length,
    } satisfies ResourceCounts;
  });
}

async function waitForSettledTerminal(
  page: Page,
  terminalId: string,
  requireActive = true,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout, requireActive: needsActive }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.lifecycle.mounted
      && snapshot.lifecycle.visible
      && (!needsActive || snapshot.lifecycle.active)
      && (!needsActive || snapshot.lifecycle.acceptingInput)
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS, requireActive });
}

async function createFixtureTerminal(
  page: Page,
  workbench: WorkbenchPage,
  shell: string,
  name: string,
): Promise<{ readonly id: string; readonly name: string }> {
  const created = await page.evaluate(async ({ path, fixtureShell }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, cwd: "/tmp", shell: fixtureShell }),
    });
    if (!response.ok) throw new Error(`terminal creation failed with HTTP ${response.status}`);
    const payload = await response.json() as { id?: unknown; name?: unknown };
    if (typeof payload.id !== "string" || typeof payload.name !== "string") {
      throw new Error("terminal creation response is missing id or name");
    }
    return { id: payload.id, name: payload.name };
  }, { path: name, fixtureShell: shell });
  await page.reload({ waitUntil: "load" });
  await workbench.expectVisible();
  const row = await workbench.sidebar.terminalRow({ id: created.id, name: created.name });
  await expect(row).toBeVisible();
  const pane = await workbench.openTerminal({ id: created.id, name: created.name });
  await pane.expectVisible();
  const synchronized = page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, {
      socketState: "connected",
    }, { timeout });
  }, { id: created.id, timeout: WAIT_TIMEOUT_MS });
  await synchronized;
  return { id: created.id, name: created.name };
}

async function applyScrollbackSetting(
  page: Page,
  settings: SettingsPage,
  terminalId: string,
  faultController: NetworkFaultController,
  value: number | undefined,
): Promise<RendererRecreation> {
  const oldSnapshot = await terminalSnapshot(page, terminalId);
  if (!oldSnapshot) throw new Error(`missing old diagnostics snapshot for ${terminalId}`);
  const oldGeneration = oldSnapshot.socketGeneration;
  const networkFloor = Date.now();
  const oldUnmountPromise = page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.type === "unmount", { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
  const oldClosePromise = faultController.waitFor((event) => (
    event.terminalId === terminalId
    && event.generation === oldGeneration
    && event.at > networkFloor
    && (event.type === "connection-closed" || event.type === "connection-terminated")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const newOpenPromise = faultController.waitFor((event) => (
    event.terminalId === terminalId
    && event.generation !== oldGeneration
    && event.at > networkFloor
    && event.type === "connection-open"
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  if (value === undefined) await settings.useServerScrollbackDefault();
  else await settings.setTerminalScrollback(value);

  const oldUnmount = await oldUnmountPromise;
  const oldClose = await oldClosePromise;
  const newMount = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.type === "mount", { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
  const newOpen = await newOpenPromise;
  const current = await waitForSettledTerminal(page, terminalId, false);
  return { oldSnapshot, oldUnmount, newMount, current, oldClose, newOpen };
}

function commandBase64(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function countCommand(entries: readonly Record<string, unknown>[], command: string): number {
  const encoded = commandBase64(command);
  return entries.filter((entry) => entry.event === "command" && entry.command_base64 === encoded).length;
}

test("W-07 Change browser scrollback setting @p1 @chromium-pr @config @scrollback @nightly", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `W07-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const terminalPath = `w07-${runTag}`;
  const readyId = `${runTag}-READY`;
  const oldId = `${runTag}-OLDEST`;
  const oldText = `${runTag}-OLDEST-HISTORY`;
  const burstId = `${runTag}-BURST`;
  const liveId = `${runTag}-LIVE`;
  const liveText = `${runTag}-LIVE-HISTORY`;
  const afterId = `${runTag}-AFTER`;
  const afterText = `${runTag}-AFTER-SCROLLBACK`;
  const echoId = `${runTag}-ECHO`;
  const echoText = `${runTag}-CONTINUED-INPUT`;
  const sizeId = `${runTag}-SIZE`;
  const oldMarker = `[E2E:PRINT:${oldId}:${oldText}]`;
  const liveMarker = `[E2E:PRINT:${liveId}:${liveText}]`;
  const afterMarker = `[E2E:PRINT:${afterId}:${afterText}]`;
  const echoPayload = Buffer.from(echoText, "utf8").toString("base64");
  const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${echoPayload}]`;

  try {
    await page.setViewportSize(VIEWPORT);
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const config = await readClientConfig(page);
    expect(config.scrollbackLines).toBeGreaterThanOrEqual(SCROLLBACK_OVERRIDE);

    const created = await createFixtureTerminal(page, workbench, server.fixturePath, terminalPath);
    const terminalId = created.id;
    const pane = workbench.terminal(terminalId, created.name);
    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`PRINT ${oldId} ${oldText}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === oldId && entry.text === oldText, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: oldMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "burst" && entry.id === burstId && entry.bytes === BURST_BYTES, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`PRINT ${liveId} ${liveText}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === liveId && entry.text === liveText, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: liveMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const initial = await waitForSettledTerminal(page, terminalId);
    expect(initial.lifecycle.mounted).toBe(true);
    expect(initial.lifecycle.visible).toBe(true);
    expect(initial.lifecycle.active).toBe(true);
    expect(initial.socketState).toBe("connected");
    expect(initial.activeSocketCount).toBe(1);
    expect(initial.renderer).toMatch(/^(webgl|canvas|dom)$/);
    expect(initial.webglLoadCount + initial.fallbackCount).toBeGreaterThan(0);
    expect(initial.renderCount).toBeGreaterThan(0);
    expect(initial.xterm.text).toContain(oldMarker);
    expect(initial.xterm.text).toContain(liveMarker);
    const initialInfo = await readTerminal(page, terminalId);
    expect(initialInfo.pid).not.toBeNull();
    expect(initialInfo.status).toBe("running");
    const beforePixels = await screenshotRegion(page, pane.xtermHost.locator(".xterm-screen"));
    await expectTerminalNonBlank(page, pane.xtermHost, { testInfo, artifactName: "w07-before-scrollback" });

    const settings = await workbench.openSettings();
    await expect(settings.root.getByRole("spinbutton", { name: "Terminal scrollback lines", exact: true }))
      .toHaveAttribute("min", String(1_000));
    await expect(settings.root.getByRole("spinbutton", { name: "Terminal scrollback lines", exact: true }))
      .toHaveAttribute("max", String(2_000_000));
    await expect(settings.root.getByRole("spinbutton", { name: "Terminal scrollback lines", exact: true }))
      .toHaveAttribute("step", String(1_000));

    const changed = await applyScrollbackSetting(page, settings, terminalId, faultController, SCROLLBACK_OVERRIDE);
    expect(changed.oldSnapshot.paneId).toBe(changed.oldUnmount.paneId);
    expect(changed.oldUnmount.type).toBe("unmount");
    expect(changed.oldUnmount.snapshot.lifecycle).toMatchObject({
      mounted: false,
      visible: false,
      cached: true,
      active: false,
      focused: false,
      acceptingInput: false,
    });
    expect(changed.oldUnmount.snapshot.activeSocketCount).toBe(0);
    expect(changed.oldUnmount.snapshot.socket.activeCount).toBe(0);
    expect(changed.newMount.type).toBe("mount");
    expect(changed.newMount.snapshot.lifecycle.mounted).toBe(true);
    expect(changed.newMount.snapshot.activeSocketCount).toBe(0);
    expect(changed.current.paneId).toBe(changed.oldSnapshot.paneId);
    expect(changed.current.socketState).toBe("connected");
    expect(changed.current.activeSocketCount).toBe(1);
    expect(changed.current.socket.activeCount).toBe(1);
    expect(changed.current.renderer).toMatch(/^(webgl|canvas|dom)$/);
    expect(changed.current.webglLoadCount + changed.current.fallbackCount).toBeGreaterThan(0);
    expect(changed.current.renderCount).toBeGreaterThan(0);
    expect(changed.current.xterm.text).not.toContain(oldMarker);
    expect(changed.current.xterm.text).toContain(liveMarker);
    expect(changed.current.xterm.text.match(new RegExp(`\\[E2E:PRINT:${liveId}:`, "g"))).toHaveLength(1);
    expect(await page.evaluate((key) => localStorage.getItem(key), TERMINAL_SCROLLBACK_STORAGE_KEY)).toBe(String(SCROLLBACK_OVERRIDE));
    await expect(settings.root.getByRole("spinbutton", { name: "Terminal scrollback lines", exact: true }))
      .toHaveValue(String(SCROLLBACK_OVERRIDE));
    await expect(workbench.statusbar.locator(".statusbar-scrollback")).toHaveText("1,000 line scrollback");

    const currentEvents = await terminalEvents(page, terminalId);
    expect(currentEvents.filter((event) => event.type === "mount")).toHaveLength(1);
    expect(currentEvents.filter((event) => event.type === "unmount")).toHaveLength(0);
    expect(currentEvents.filter((event) => event.type === "renderer-load" || event.type === "renderer-fallback")).toHaveLength(1);
    expect(currentEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(currentEvents.filter((event) => event.type === "synced")).toHaveLength(1);
    await assertMonotonicSequences(currentEvents);
    const resourcesAfterChange = await readResources(page);
    expect(resourcesAfterChange.paneSlots).toBe(1);
    expect(resourcesAfterChange.terminalNodes).toBe(1);
    expect(resourcesAfterChange.canvasCount).toBeGreaterThan(0);
    expect(resourcesAfterChange.canvasCount).toBeLessThanOrEqual(2);
    expect((await page.evaluate(() => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.terminals().filter((snapshot) => snapshot.kind === "pane");
    }))).toHaveLength(1);

    await workbench.closeSettings();
    await pane.expectVisible();
    await expectTerminalNonBlank(page, pane.xtermHost, { testInfo, artifactName: "w07-after-scrollback" });
    await pane.sendInput(`PRINT ${afterId} ${afterText}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === afterId && entry.text === afterText, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    const afterPixels = await expectKnownMarkerChanged(page, pane.xtermHost.locator(".xterm-screen"), beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "w07-after-marker",
    });
    expect(afterPixels.after.width).toBe(beforePixels.width);
    expect(afterPixels.after.height).toBe(beforePixels.height);

    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: `[E2E:ECHO_INPUT:${echoId}:READY]`, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await pane.sendInput(echoText, true);
    const echoEntry = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload" && entry.payload_base64 === echoPayload,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echoEntry.payload_base64).toBe(echoPayload);
    await expectTerminalBuffer(page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await pane.sendInput(`SIZE ${sizeId}`, true);
    const sizeEntry = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number; pixel_width: number; pixel_height: number }>(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sizeId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const finalBeforeReset = await expectTerminalConverged(page, terminalId, {
      cols: changed.current.cols,
      rows: changed.current.rows,
      pixelWidth: changed.current.pixelWidth,
      pixelHeight: changed.current.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    expect(sizeEntry.rows).toBe(finalBeforeReset.rows);
    expect(sizeEntry.cols).toBe(finalBeforeReset.cols);
    expect(sizeEntry.pixel_width).toBe(finalBeforeReset.pixelWidth);
    expect(sizeEntry.pixel_height).toBe(finalBeforeReset.pixelHeight);
    expect(finalBeforeReset.xterm.text).toContain(afterMarker);
    expect(finalBeforeReset.xterm.text).toContain(echoMarker);
    expect(finalBeforeReset.xterm.text).not.toContain(oldMarker);
    expect(finalBeforeReset.xterm.text.match(new RegExp(`\\[E2E:PRINT:${afterId}:`, "g"))).toHaveLength(1);
    expect(finalBeforeReset.xterm.text.match(new RegExp(`\\[E2E:ECHO_INPUT:${echoId}:`, "g"))).toHaveLength(1);
    assertNoPendingSynchronization(finalBeforeReset);
    const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await assertMonotonicSequences(invariantReport.events);

    const settingsForReset = await workbench.openSettings();
    const reset = await applyScrollbackSetting(page, settingsForReset, terminalId, faultController, undefined);
    expect(reset.oldUnmount.snapshot.activeSocketCount).toBe(0);
    expect(reset.newMount.snapshot.lifecycle.mounted).toBe(true);
    expect(reset.current.activeSocketCount).toBe(1);
    expect(reset.current.xterm.text).toContain(afterMarker);
    expect(await page.evaluate((key) => localStorage.getItem(key), TERMINAL_SCROLLBACK_STORAGE_KEY)).toBeNull();
    await expect(settingsForReset.root.getByRole("spinbutton", { name: "Terminal scrollback lines", exact: true }))
      .toHaveValue(String(config.scrollbackLines));
    await expect(workbench.statusbar.locator(".statusbar-scrollback"))
      .toHaveText(`${config.scrollbackLines.toLocaleString()} line scrollback`);
    await workbench.closeSettings();
    await pane.expectVisible();
    const final = await waitForSettledTerminal(page, terminalId);
    expect(final.xterm.text).toContain(afterMarker);
    expect(final.xterm.text).toContain(echoMarker);
    expect(final.activeSocketCount).toBe(1);
    expect((await readResources(page)).paneSlots).toBe(1);
    await expectTerminalNonBlank(page, pane.xtermHost, { testInfo, artifactName: "w07-reset-terminal" });

    const finalInfo = await readTerminal(page, terminalId);
    expect(finalInfo.pid).toBe(initialInfo.pid);
    expect(finalInfo.status).toBe("running");
    expect(finalInfo.clients).toBeLessThanOrEqual(1);
    const transcript = await server.readTranscript(terminalId);
    for (const command of [
      `READY ${readyId}`,
      `PRINT ${oldId} ${oldText}`,
      `BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`,
      `PRINT ${liveId} ${liveText}`,
      `PRINT ${afterId} ${afterText}`,
      `ECHO_INPUT ${echoId}`,
      echoText,
      `SIZE ${sizeId}`,
    ]) expect(countCommand(transcript, command), `fixture command duplicated or omitted: ${command}`).toBe(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === oldId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === liveId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === afterId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "error" || entry.event === "exit")).toHaveLength(0);
    const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
    expect(networkEvents.filter((event) => event.type === "socket-error")).toHaveLength(0);
    expect(networkEvents.filter((event) => event.type === "malformed-frame")).toHaveLength(0);
    expect(networkEvents.filter((event) => event.type === "connection-closed" || event.type === "connection-terminated").length).toBeGreaterThanOrEqual(2);
    const browserFailures = browserErrors().filter((entry) => (
      entry.kind === "pageerror"
      || entry.kind === "requestfailed"
      || entry.kind === "console" && /^error:/i.test(entry.message)
    ));
    expect(browserFailures).toEqual([]);
    expect(server.stderr).not.toMatch(/\b(?:panic|internal server error|unhandled|fatal error)\b/i);
    browserErrors.dispose();
  } finally {
    browserErrors.dispose();
  }
});
