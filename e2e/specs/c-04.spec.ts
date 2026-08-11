import { expect, test } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalConverged,
  expectTerminalInteractive,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { expectKnownMarkerChanged, expectTerminalNonBlank, screenshotRegion } from "../assertions/terminal-pixels.js";
import type { TranscriptEntry } from "../fixtures/isolated-server.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 30_000;
const HANDSHAKE_DELAY_MS = 5_000;

// Keep the physical viewport transition deterministic, but derive terminal
// cell geometry from the diagnostics reported by the live layout. Font loading
// and responsive pane chrome can change the fit result without changing the
// handshake scenario.
const BROWSER_GEOMETRY_A = { width: 915, height: 421 } as const;
const BROWSER_GEOMETRY_B = { width: 1_227, height: 601 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly pid: number | null;
  readonly status: string;
  readonly clients: number;
  readonly broker?: {
    readonly version: string;
    readonly commit: string;
  } | null;
};

type BrokerConfig = {
  readonly version: string;
  readonly commit: string;
  readonly sessions: number;
  readonly generations: readonly {
    readonly version: string;
    readonly commit: string;
    readonly sessions: number;
    readonly current: boolean;
  }[];
};

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(value, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + Math.max(1, value.length);
  }
}

function wrappedMarker(raw: string, marker: string): { readonly lineBreaks: number } | undefined {
  for (let start = 0; start < raw.length; start += 1) {
    let markerOffset = 0;
    let lineBreaks = 0;
    for (let index = start; index < raw.length && markerOffset < marker.length; index += 1) {
      const character = raw[index];
      if (character === "\n" || character === "\r") {
        lineBreaks += 1;
        continue;
      }
      if (character !== marker[markerOffset]) break;
      markerOffset += 1;
    }
    if (markerOffset === marker.length) return { lineBreaks };
  }
  return undefined;
}

function isResizeFrame(event: {
  readonly type: string;
  readonly terminalId?: string;
  readonly direction?: string;
  readonly frame?: { readonly jsonType?: string };
}, terminalId: string): boolean {
  return event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "resize";
}

async function waitForConnectingViewport(
  page: Page,
  terminalId: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.urlViewport;
      return snapshot.socketState === "connecting"
        && snapshot.socketReadyState === 0
        && viewport !== undefined
        && viewport.cols > 0
        && viewport.rows > 0;
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function waitForConnectingResize(
  page: Page,
  terminalId: string,
  previous: { readonly cols: number; readonly rows: number },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previous, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.desiredViewport;
      return snapshot.socketState === "connecting"
        && snapshot.socketReadyState === 0
        && viewport !== undefined
        && viewport.cols > 0
        && viewport.rows > 0
        && (viewport.cols !== previous.cols || viewport.rows !== previous.rows);
    }, { timeout });
  }, { id: terminalId, previous, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPaneActive(page: Page, terminalId: string, active: boolean): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, active, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.active === active, { timeout });
  }, { id: terminalId, active, timeout: WAIT_TIMEOUT_MS });
}

async function waitForMarker(page: Page, terminalId: string, marker: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, marker: expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const text = snapshot.xterm.text.replaceAll("\n", "").replaceAll("\r", "");
      return text.includes(expected);
    }, { timeout });
  }, { id: terminalId, marker, timeout: WAIT_TIMEOUT_MS });
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} was not found in the server listing`);
    return terminal;
  }, terminalId);
}

async function readBrokerConfig(page: Page): Promise<BrokerConfig> {
  return page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`config request failed with HTTP ${response.status}`);
    const config = await response.json() as { broker?: BrokerConfig | null };
    if (!config.broker) throw new Error("server did not expose broker diagnostics");
    return config.broker;
  });
}

async function latestSnapshot(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const snapshot = api.terminal(id);
    if (!snapshot) throw new Error(`No diagnostics snapshot for terminal ${id}`);
    return snapshot;
  }, terminalId);
}

async function waitForCommand(
  server: {
    waitForTranscript<T extends TranscriptEntry = TranscriptEntry>(
      terminalId: string,
      predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean,
      options?: { timeoutMs?: number },
    ): Promise<T>;
  },
  terminalId: string,
  operation: string,
  command: string,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command"
      && entry.operation === operation
      && entry.command_base64 === base64(command),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

test("C-04 Delayed WebSocket handshake @nightly", async ({ page, baseURL, server, faultController }, testInfo) => {
  const runId = `w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-${Date.now()}`;
  const readyId = `C04-READY-${runId}`;
  const holdToken = `C04-GATE-${runId}`;
  const printId = `C04-WIDTH-${runId}`;
  const sizeId = `C04-SIZE-${runId}`;
  const winchId = `C04-WINCH-${runId}`;
  const echoId = `C04-ECHO-${runId}`;
  const echoPayload = `input-C04-${runId}`;
  const widthPayload = `width-sensitive-${runId}-${"W".repeat(150)}`;
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.setViewportSize(BROWSER_GEOMETRY_A);
  const delayedUpgrade = faultController.delayUpgrade(undefined, HANDSHAKE_DELAY_MS);
  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const mount = page.evaluate(async ({ timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, { timeout: WAIT_TIMEOUT_MS });
    await workbench.createTerminal();
    const mounted = await mount;
    const terminalId = mounted.terminalId;
    const pane = new TerminalPanePage(page, terminalId);
    await pane.expectVisible();

    const delayed = await faultController.waitFor(
      (event) => event.type === "upgrade-delay" && event.terminalId === terminalId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(delayed.terminalId).toBe(terminalId);
    const connecting = await waitForConnectingViewport(page, terminalId);
    const connectingUrl = connecting.urlViewport;
    if (!connectingUrl) throw new Error("connecting terminal did not expose its URL viewport");
    const geometryA = {
      cols: connectingUrl.cols,
      rows: connectingUrl.rows,
    } as const;
    expect(connectingUrl).toMatchObject({ ...geometryA, source: "url" });
    expect(connecting.socketReadyState).toBe(0);
    expect(connecting.socketState).toBe("connecting");
    expect(connecting.activeSocketCount).toBe(1);
    const initialTerminal = await readTerminal(page, terminalId);
    expect(initialTerminal.id).toBe(terminalId);
    expect(initialTerminal.status).toBe("running");
    if (initialTerminal.pid === null) throw new Error(`terminal ${terminalId} does not expose a PTY process identity`);
    const initialPid = initialTerminal.pid;

    const beforeResizeFrames = faultController.events.filter((event) => isResizeFrame(event, terminalId));
    expect(beforeResizeFrames).toHaveLength(0);
    await page.setViewportSize(BROWSER_GEOMETRY_B);
    const resized = await waitForConnectingResize(page, terminalId, geometryA);
    const desired = resized.desiredViewport;
    if (!desired) throw new Error("connecting terminal did not expose its resized desired viewport");
    let geometryB = {
      cols: desired.cols,
      rows: desired.rows,
    };
    expect(geometryB).not.toEqual(geometryA);
    expect(resized.socketState).toBe("connecting");
    expect(resized.socketReadyState).toBe(0);
    expect(resized.urlViewport).toMatchObject({ ...geometryA, source: "url" });
    expect(desired).toMatchObject({ ...geometryB, source: "desired" });
    expect(resized.sentViewport).toMatchObject({ ...geometryA, source: "sent" });
    expect(faultController.events.filter((event) => isResizeFrame(event, terminalId))).toHaveLength(0);

    // Settings is a real user navigation. It removes the editor grid from the
    // rendered document and deactivates the pane without tearing down the
    // connecting socket; returning to Terminals restores focus before open.
    const hiddenInEditor = page.locator("main.editor-grid");
    await workbench.openSettings();
    await expect(hiddenInEditor).toHaveClass(/resource-hidden/);
    const inactive = await waitForPaneActive(page, terminalId, false);
    expect(inactive.lifecycle.mounted).toBe(true);
    expect(inactive.lifecycle.visible).toBe(true);
    expect(inactive.socketState).toBe("connecting");
    await workbench.closeSettings();
    await expect(hiddenInEditor).not.toHaveClass(/resource-hidden/);
    const active = await waitForPaneActive(page, terminalId, true);
    expect(active.socketState).toBe("connecting");
    await pane.focus();
    await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();

    const upgradeOpen = faultController.waitFor(
      (event) => event.type === "upgrade-open" && event.terminalId === terminalId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const socketOpen = pane.waitForEvent("socket-open", { timeout: WAIT_TIMEOUT_MS });
    const [opened] = await Promise.all([socketOpen, upgradeOpen]);
    expect(opened.type).toBe("socket-open");
    const afterOpen = await latestSnapshot(page, terminalId);
    expect(afterOpen.socketReadyState).toBe(1);
    expect(["open", "connected"]).toContain(afterOpen.socketState);
    expect(afterOpen.sentViewport).toMatchObject({ ...geometryA, source: "sent" });
    const latestDesired = afterOpen.desiredViewport;
    if (!latestDesired) throw new Error("opened terminal did not expose its latest desired viewport");
    geometryB = { cols: latestDesired.cols, rows: latestDesired.rows };
    expect(latestDesired).toMatchObject({ ...geometryB, source: "desired" });

    const resizeFrame = await faultController.waitFor(
      (event) => isResizeFrame(event, terminalId),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(resizeFrame.direction).toBe("browser-to-server");
    expect(resizeFrame.frame?.jsonType).toBe("resize");
    const allResizeFrames = faultController.events.filter((event) => isResizeFrame(event, terminalId));
    expect(allResizeFrames).toHaveLength(1);

    const synchronized = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    expect(synchronized.socketState).toBe("connected");
    expect(synchronized.acceptingInput).toBe(true);
    const converged = await expectTerminalConverged(page, terminalId, geometryB, { timeout: WAIT_TIMEOUT_MS });
    expect(converged.cols).toBe(geometryB.cols);
    expect(converged.rows).toBe(geometryB.rows);
    expect(converged.xterm.cursorX).toBeGreaterThanOrEqual(0);
    expect(converged.xterm.cursorY).toBeGreaterThanOrEqual(0);
    expect(converged.sentViewport).toMatchObject({ ...geometryB, source: "sent" });
    expect(converged.serverViewport).toMatchObject({ ...geometryB, source: "server" });

    await pane.sendInput(`READY ${readyId}`, true);
    await waitForCommand(server, terminalId, "READY", `READY ${readyId}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(`HOLD ${holdToken}`, true);
    await waitForCommand(server, terminalId, "HOLD", `HOLD ${holdToken}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });

    const beforeWidthMarker = await screenshotRegion(page, pane.xtermHost);
    await pane.sendInput(`RELEASE ${holdToken}`, true);
    await waitForCommand(server, terminalId, "RELEASE", `RELEASE ${holdToken}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });

    await pane.sendInput(`PRINT ${printId} ${widthPayload}`, true);
    await waitForCommand(server, terminalId, "PRINT", `PRINT ${printId} ${widthPayload}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === printId && entry.text === widthPayload, { timeoutMs: WAIT_TIMEOUT_MS });
    const widthMarker = `[E2E:PRINT:${printId}:${widthPayload}]`;
    const widthSnapshot = await waitForMarker(page, terminalId, widthMarker);
    const flattenedWidthText = widthSnapshot.xterm.text.replaceAll("\n", "").replaceAll("\r", "");
    expect(countOccurrences(flattenedWidthText, widthMarker)).toBe(1);
    const wrapped = wrappedMarker(widthSnapshot.xterm.text, widthMarker);
    expect(wrapped).toBeDefined();
    expect(wrapped?.lineBreaks).toBeGreaterThan(0);
    await expectKnownMarkerChanged(page, pane.xtermHost, beforeWidthMarker, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "c04-width-sensitive-marker",
    });

    await pane.sendInput(`SIZE ${sizeId}`, true);
    const size = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number; pixel_width: number; pixel_height: number }>(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sizeId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(size.rows).toBe(geometryB.rows);
    expect(size.cols).toBe(geometryB.cols);
    expect(size.pixel_width).toBe(converged.pixelWidth);
    expect(size.pixel_height).toBe(converged.pixelHeight);

    const winchSequence = 1;
    await pane.sendInput(`WINCH ${winchId} ${winchSequence} ${geometryB.rows} ${geometryB.cols}`, true);
    const winch = await server.waitForTranscript<{ event: string; id: string; source: string; signal_sequence: number; rows: number; cols: number; actual_rows: number; actual_cols: number }>(
      terminalId,
      (entry) => entry.event === "sigwinch" && entry.id === winchId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(winch.source).toBe("command");
    expect(winch.signal_sequence).toBe(winchSequence);
    expect(winch.rows).toBe(geometryB.rows);
    expect(winch.cols).toBe(geometryB.cols);
    expect(winch.actual_rows).toBe(geometryB.rows);
    expect(winch.actual_cols).toBe(geometryB.cols);

    await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await waitForCommand(server, terminalId, "ECHO_INPUT", `ECHO_INPUT ${echoId}`);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
    await pane.sendInput(echoPayload, true);
    const echo = await server.waitForTranscript<{ event: string; id: string; phase: string; bytes: number; payload_base64: string }>(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(echo.bytes).toBe(Buffer.byteLength(echoPayload, "utf8"));
    expect(echo.payload_base64).toBe(base64(echoPayload));
    const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${base64(echoPayload)}]`;
    const echoSnapshot = await waitForMarker(page, terminalId, echoMarker);
    expect(countOccurrences(echoSnapshot.xterm.text.replaceAll("\n", "").replaceAll("\r", ""), echoMarker)).toBe(1);

    const final = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(final.socketGeneration).toBe(connecting.socketGeneration);
    expect(final.activeSocketCount).toBe(1);
    expect(final.cols).toBe(geometryB.cols);
    expect(final.rows).toBe(geometryB.rows);
    expect(final.viewport.cols).toBe(geometryB.cols);
    expect(final.viewport.rows).toBe(geometryB.rows);
    expect(final.sentViewport).toMatchObject({ ...geometryB, source: "sent" });
    expect(final.serverViewport).toMatchObject({ ...geometryB, source: "server" });
    expect(final.acceptingInput).toBe(true);
    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

    const terminalAfter = await readTerminal(page, terminalId);
    expect(terminalAfter.id).toBe(initialTerminal.id);
    expect(terminalAfter.pid).toBe(initialPid);
    expect(terminalAfter.status).toBe("running");
    expect(terminalAfter.clients).toBe(1);
    expect(terminalAfter.broker).toBeDefined();
    const broker = await readBrokerConfig(page);
    const currentGeneration = broker.generations.find((generation) => generation.current);
    expect(currentGeneration).toBeDefined();
    expect(currentGeneration?.sessions).toBeGreaterThanOrEqual(1);
    expect(terminalAfter.broker?.version).toBe(currentGeneration?.version);
    expect(terminalAfter.broker?.commit).toBe(currentGeneration?.commit);

    const events = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(events);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
    expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(events.filter((event) => event.type === "socket-open")).toHaveLength(1);
    expect(events.filter((event) => event.type === "viewport" && event.data.source === "sent" && event.data.cols === geometryB.cols && event.data.rows === geometryB.rows)).toHaveLength(1);
    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === printId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "sigwinch" && entry.id === winchId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "command" && entry.operation === "RELEASE" && entry.command_base64 === base64(`RELEASE ${holdToken}`))).toHaveLength(1);
    expect(browserErrors).toEqual([]);

    await expectTerminalNonBlank(page, pane.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "c04-final-terminal",
    });
  } finally {
    delayedUpgrade.dispose();
  }
});
