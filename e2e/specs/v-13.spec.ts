import { devices, type Page } from "@playwright/test";
import { expect, test, type TranscriptEntry } from "../fixtures/test.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectTerminalSynchronized,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import LoginPage from "../pages/login-page.js";
import TerminalPanePage from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";

const WAIT_TIMEOUT = 30_000;
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const KEYBOARD_VIEWPORT = { width: 390, height: 500, offsetLeft: 0, offsetTop: 344 } as const;
const MOBILE_DPR = 2;

// Keep the test in a real mobile context even when a nightly browser project
// uses the desktop defaults from playwright.config.ts.
test.use({
  ...devices["iPhone 13"],
  viewport: MOBILE_VIEWPORT,
  deviceScaleFactor: MOBILE_DPR,
  isMobile: true,
  hasTouch: true,
});

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CdpSessionLike = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};

type FixtureServer = {
  readTranscript(terminalId: string): Promise<TranscriptEntry[]>;
  waitForTranscript<T extends TranscriptEntry = TranscriptEntry>(
    terminalId: string,
    predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<T>;
};

type VisualViewportState = {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
  innerWidth: number;
  innerHeight: number;
  cssWidth: number;
  cssHeight: number;
  cssLeft: number;
  cssTop: number;
  appRect: { left: number; top: number; width: number; height: number };
};

function numberField(entry: TranscriptEntry, field: string): number {
  const value = entry[field];
  if (typeof value !== "number") throw new Error(`transcript ${field} is not numeric`);
  return value;
}

function latestSequence(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((latest, entry) => {
    const sequence = entry.sequence;
    return typeof sequence === "number" && sequence > latest ? sequence : latest;
  }, 0);
}

function latestEventId(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.id), -1);
}

function isSentViewportEvent(event: E2ETerminalEvent, viewport: E2EViewport): boolean {
  const data = event.data;
  return event.type === "viewport"
    && data.source === "sent"
    && data.cols === viewport.cols
    && data.rows === viewport.rows
    && data.pixelWidth === viewport.pixelWidth
    && data.pixelHeight === viewport.pixelHeight;
}


async function waitForVisualViewport(
  page: Page,
  expected: { width: number; height: number; offsetLeft?: number; offsetTop?: number },
): Promise<VisualViewportState> {
  return page.evaluate(async ({ expected: target, timeout }) => {
    const read = (): VisualViewportState => {
      const viewport = window.visualViewport;
      if (!viewport) throw new Error("mobile visualViewport API is unavailable");
      const rootStyle = getComputedStyle(document.documentElement);
      const app = document.querySelector<HTMLElement>("#app");
      if (!app) throw new Error("application root is unavailable");
      const rect = app.getBoundingClientRect();
      const number = (value: string): number => Number.parseFloat(value);
      return {
        width: viewport.width,
        height: viewport.height,
        offsetLeft: viewport.offsetLeft,
        offsetTop: viewport.offsetTop,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        cssWidth: number(rootStyle.getPropertyValue("--visual-viewport-width")),
        cssHeight: number(rootStyle.getPropertyValue("--visual-viewport-height")),
        cssLeft: number(rootStyle.getPropertyValue("--visual-viewport-left")),
        cssTop: number(rootStyle.getPropertyValue("--visual-viewport-top")),
        appRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      } satisfies VisualViewportState;
    };
    const closeEnough = (left: number, right: number): boolean => Math.abs(left - right) <= 0.5;
    const settled = (state: VisualViewportState): boolean => (
      closeEnough(state.width, target.width)
      && closeEnough(state.height, target.height)
      && (target.offsetLeft === undefined || closeEnough(state.offsetLeft, target.offsetLeft))
      && (target.offsetTop === undefined || closeEnough(state.offsetTop, target.offsetTop))
      && closeEnough(state.cssWidth, state.width)
      && closeEnough(state.cssHeight, state.height)
      && closeEnough(state.cssLeft, state.offsetLeft)
      && closeEnough(state.cssTop, state.offsetTop)
      && closeEnough(state.appRect.left, state.cssLeft)
      && closeEnough(state.appRect.top, state.cssTop)
      && closeEnough(state.appRect.width, state.cssWidth)
      && closeEnough(state.appRect.height, state.cssHeight)
    );

    return new Promise<VisualViewportState>((resolve, reject) => {
      let finished = false;
      let timer = 0;
      const viewport = window.visualViewport;
      const cleanup = () => {
        viewport?.removeEventListener("resize", check);
        viewport?.removeEventListener("scroll", check);
        window.removeEventListener("resize", check);
        window.removeEventListener("orientationchange", check);
        if (timer) window.clearTimeout(timer);
      };
      const finish = (state: VisualViewportState) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(state);
      };
      const check = () => {
        const state = read();
        if (settled(state)) finish(state);
      };
      viewport?.addEventListener("resize", check);
      viewport?.addEventListener("scroll", check);
      window.addEventListener("resize", check);
      window.addEventListener("orientationchange", check);
      timer = window.setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error(`timed out waiting for visual viewport ${target.width}x${target.height}`));
      }, timeout);
      check();
    });
  }, { expected, timeout: WAIT_TIMEOUT });
}

async function waitForSettledViewport(
  page: Page,
  terminalId: string,
  previous: E2EViewport,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previousViewport, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const same = (left: E2EViewport | undefined, right: E2EViewport | undefined): boolean => (
      left !== undefined
      && right !== undefined
      && left.cols === right.cols
      && left.rows === right.rows
      && left.pixelWidth === right.pixelWidth
      && left.pixelHeight === right.pixelHeight
    );
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const sent = snapshot.sentViewport;
      const server = snapshot.serverViewport;
      return snapshot.socketState === "connected"
        && snapshot.pendingParserWrites === 0
        && desired !== undefined
        && sent !== undefined
        && server !== undefined
        && !same(desired, previousViewport)
        && same(desired, sent)
        && same(sent, server);
    }, { timeout });
  }, { id: terminalId, previousViewport: previous, timeout: WAIT_TIMEOUT });
}

async function setCdpVisualViewport(
  cdp: CdpSessionLike,
  target: typeof KEYBOARD_VIEWPORT | typeof MOBILE_VIEWPORT,
): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: target.width,
    height: target.height,
    deviceScaleFactor: MOBILE_DPR,
    mobile: true,
    screenWidth: MOBILE_VIEWPORT.width,
    screenHeight: MOBILE_VIEWPORT.height,
    viewport: {
      x: "offsetLeft" in target ? target.offsetLeft : 0,
      y: "offsetTop" in target ? target.offsetTop : 0,
      width: target.width,
      height: target.height,
      scale: 1,
    },
  });
}

async function applyVisualViewport(
  page: Page,
  cdp: CdpSessionLike | undefined,
  target: typeof KEYBOARD_VIEWPORT | typeof MOBILE_VIEWPORT,
): Promise<"cdp" | "layout"> {
  if (cdp) {
    await setCdpVisualViewport(cdp, target);
    return "cdp";
  }
  await page.setViewportSize({ width: target.width, height: target.height });
  return "layout";
}
async function waitForQuery(
  page: Page,
  pane: TerminalPanePage,
  server: FixtureServer,
  terminalId: string,
  id: string,
): Promise<void> {
  await pane.sendInput(`QUERY ${id}`, true);
  const complete = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "query_complete" && entry.id === id,
    { timeoutMs: WAIT_TIMEOUT },
  );
  expect(numberField(complete, "replies")).toBe(4);
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:QUERY:${id}:COMPLETE:4]` }, { timeout: WAIT_TIMEOUT });
}

async function sendPrint(
  page: Page,
  pane: TerminalPanePage,
  server: FixtureServer,
  terminalId: string,
  id: string,
  text: string,
): Promise<string> {
  await pane.sendInput(`PRINT ${id} ${text}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === id,
    { timeoutMs: WAIT_TIMEOUT },
  );
  const marker = `[E2E:PRINT:${id}:${text}]`;
  await expectTerminalBuffer(page, terminalId, { contains: marker, occurrences: 1 }, { timeout: WAIT_TIMEOUT });
  return marker;
}

async function waitForSize(
  server: FixtureServer,
  terminalId: string,
  id: string,
  expected: { cols: number; rows: number },
): Promise<void> {
  const entry = await server.waitForTranscript(
    terminalId,
    (candidate) => candidate.event === "size" && candidate.id === id,
    { timeoutMs: WAIT_TIMEOUT },
  );
  expect(numberField(entry, "cols")).toBe(expected.cols);
  expect(numberField(entry, "rows")).toBe(expected.rows);
}

async function waitForWinchCommand(
  server: FixtureServer,
  terminalId: string,
  id: string,
  sequence: number,
  expected: { cols: number; rows: number },
): Promise<void> {
  const entry = await server.waitForTranscript(
    terminalId,
    (candidate) => candidate.event === "sigwinch" && candidate.id === id && candidate.source === "command",
    { timeoutMs: WAIT_TIMEOUT },
  );
  expect(numberField(entry, "signal_sequence")).toBe(sequence);
  expect(numberField(entry, "cols")).toBe(expected.cols);
  expect(numberField(entry, "rows")).toBe(expected.rows);
  expect(numberField(entry, "actual_cols")).toBe(expected.cols);
  expect(numberField(entry, "actual_rows")).toBe(expected.rows);
}

async function expectMobileLayout(page: Page, expected: VisualViewportState): Promise<void> {
  const layout = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>(".mobile-toolbar");
    const pane = document.querySelector<HTMLElement>(".terminal-pane");
    const keybar = document.querySelector<HTMLElement>(".terminal-keybar");
    if (!toolbar || !pane || !keybar) throw new Error("mobile terminal layout is incomplete");
    const rows = getComputedStyle(pane).gridTemplateRows
      .split(" ")
      .map((value) => Number.parseFloat(value))
      .filter((value) => Number.isFinite(value));
    return {
      toolbarHeight: toolbar.getBoundingClientRect().height,
      paneHeight: pane.getBoundingClientRect().height,
      rows,
      keybarVisible: getComputedStyle(keybar).display !== "none",
    };
  });
  expect(layout.toolbarHeight).toBeCloseTo(44, 0);
  expect(layout.paneHeight).toBeGreaterThan(44 + 45);
  expect(layout.rows.length).toBe(3);
  expect(layout.rows[0]).toBeCloseTo(44, 0);
  expect(layout.rows[2]).toBeGreaterThanOrEqual(45);
  expect(layout.keybarVisible).toBe(true);
  expect(expected.appRect.left).toBeCloseTo(expected.cssLeft, 0);
  expect(expected.appRect.top).toBeCloseTo(expected.cssTop, 0);
  expect(expected.appRect.width).toBeCloseTo(expected.cssWidth, 0);
  expect(expected.appRect.height).toBeCloseTo(expected.cssHeight, 0);
}

test("V-13 Mobile visual viewport and virtual keyboard @nightly @mobile @resize", async ({ page, baseURL, server }, testInfo) => {
  const browserErrors: string[] = [];
  const onPageError = (error: Error): void => {
    browserErrors.push(error.message);
  };
  const onConsole = (message: { type(): string; text(): string }): void => {
    if (message.type() === "error") browserErrors.push(message.text());
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);

  const token = `V13-w${testInfo.workerIndex}-p${testInfo.parallelIndex}`;
  const readyId = `${token}-READY`;
  const beforePrintId = `${token}-BEFORE`;
  const openPrintId = `${token}-KBD`;
  const restoredPrintId = `${token}-RESTORED`;
  const beforeSizeId = `${token}-SIZE-BEFORE`;
  const openSizeId = `${token}-SIZE-KBD`;
  const restoredSizeId = `${token}-SIZE-RESTORED`;
  const openWinchId = `${token}-WINCH-KBD`;
  const restoredWinchId = `${token}-WINCH-RESTORED`;
  const beforeQueryId = `${token}-QUERY-BEFORE`;
  const openQueryId = `${token}-QUERY-KBD`;
  const restoredQueryId = `${token}-QUERY-RESTORED`;
  const echoId = `${token}-ECHO`;
  const captureId = `${token}-KEYBAR-ESC`;
  const echoPayload = `${token}-CONTINUED-INPUT`;

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountBarrier = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, WAIT_TIMEOUT);
  await workbench.createTerminal();
  const mount = await mountBarrier;
  const terminalId = mount.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT });

  const helperTextarea = pane.xtermHost.locator(".xterm-helper-textarea");
  await expect(helperTextarea).toBeAttached();
  await helperTextarea.focus();
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT });
  await expect(pane.root.locator(".terminal-keybar")).toBeVisible();

  const initialVisual = await waitForVisualViewport(page, {
    width: MOBILE_VIEWPORT.width,
    height: MOBILE_VIEWPORT.height,
    offsetLeft: 0,
    offsetTop: 0,
  });
  await expectMobileLayout(page, initialVisual);
  const initial = await terminalSnapshot(page, terminalId);
  if (!initial) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  const initialConverged = await expectTerminalConverged(page, terminalId, {
    cols: initial.cols,
    rows: initial.rows,
  }, { timeout: WAIT_TIMEOUT });
  const initialViewport = initialConverged.sentViewport ?? initialConverged.desiredViewport ?? initialConverged.viewport;
  if (!initialViewport) throw new Error(`No initial viewport for terminal ${terminalId}`);

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT },
  );
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:READY:${readyId}]` }, { timeout: WAIT_TIMEOUT });

  await pane.sendInput(`SIZE ${beforeSizeId}`, true);
  await waitForSize(server, terminalId, beforeSizeId, { cols: initialConverged.cols, rows: initialConverged.rows });
  await waitForQuery(page, pane, server, terminalId, beforeQueryId);
  const beforeMarker = await sendPrint(page, pane, server, terminalId, beforePrintId, "BEFORE");
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "v13-before-terminal-crop",
  });
  const beforePixels = await screenshotRegion(page, pane.xtermHost);

  const cdp = page.context().browser()?.browserType().name() === "chromium"
    ? await page.context().newCDPSession(page)
    : undefined;
  const eventsBeforeOpen = await pane.events();
  const openEventFloor = latestEventId(eventsBeforeOpen);
  const transcriptBeforeOpen = await server.readTranscript(terminalId);
  const openSequenceFloor = latestSequence(transcriptBeforeOpen);
  const visualOpenBarrier = waitForVisualViewport(page, {
    width: KEYBOARD_VIEWPORT.width,
    height: KEYBOARD_VIEWPORT.height,
  });
  const terminalOpenBarrier = waitForSettledViewport(page, terminalId, initialViewport);
  await applyVisualViewport(page, cdp, KEYBOARD_VIEWPORT);
  const [openVisual, openSettled] = await Promise.all([visualOpenBarrier, terminalOpenBarrier]);
  expect(openVisual.height).toBeLessThan(initialVisual.height);
  expect(openVisual.width).toBe(initialVisual.width);
  await expectMobileLayout(page, openVisual);
  const openViewport = openSettled.sentViewport ?? openSettled.desiredViewport;
  if (!openViewport) throw new Error(`No settled keyboard viewport for terminal ${terminalId}`);
  await expectTerminalConverged(page, terminalId, {
    cols: openViewport.cols,
    rows: openViewport.rows,
    pixelWidth: openViewport.pixelWidth,
    pixelHeight: openViewport.pixelHeight,
  }, { timeout: WAIT_TIMEOUT });

  const openSignal = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sigwinch"
      && entry.source === "signal"
      && typeof entry.sequence === "number"
      && entry.sequence > openSequenceFloor
      && entry.rows === openViewport.rows
      && entry.cols === openViewport.cols,
    { timeoutMs: WAIT_TIMEOUT },
  );
  expect(numberField(openSignal, "rows")).toBe(openViewport.rows);
  expect(numberField(openSignal, "cols")).toBe(openViewport.cols);

  await pane.sendInput(`WINCH ${openWinchId} 1 ${openViewport.rows} ${openViewport.cols}`, true);
  await waitForWinchCommand(server, terminalId, openWinchId, 1, { rows: openViewport.rows, cols: openViewport.cols });
  await pane.sendInput(`SIZE ${openSizeId}`, true);
  await waitForSize(server, terminalId, openSizeId, { cols: openViewport.cols, rows: openViewport.rows });
  await waitForQuery(page, pane, server, terminalId, openQueryId);
  const openPixels = await screenshotRegion(page, pane.xtermHost);
  const openMarker = await sendPrint(page, pane, server, terminalId, openPrintId, "KBD");
  await expectKnownMarkerChanged(page, pane.xtermHost, openPixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "v13-keyboard-marker-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "v13-keyboard-terminal-crop",
  });

  const eventsBeforeRestore = await pane.events();
  const restoreEventFloor = latestEventId(eventsBeforeRestore);
  const transcriptBeforeRestore = await server.readTranscript(terminalId);
  const restoreSequenceFloor = latestSequence(transcriptBeforeRestore);
  const visualRestoreBarrier = waitForVisualViewport(page, {
    width: MOBILE_VIEWPORT.width,
    height: MOBILE_VIEWPORT.height,
    offsetLeft: 0,
    offsetTop: 0,
  });
  const terminalRestoreBarrier = waitForSettledViewport(page, terminalId, openViewport);
  await applyVisualViewport(page, cdp, MOBILE_VIEWPORT);
  const [restoredVisual, restoredSettled] = await Promise.all([visualRestoreBarrier, terminalRestoreBarrier]);
  expect(restoredVisual.height).toBe(initialVisual.height);
  expect(restoredVisual.width).toBe(initialVisual.width);
  await expectMobileLayout(page, restoredVisual);
  const restoredViewport = restoredSettled.sentViewport ?? restoredSettled.desiredViewport;
  if (!restoredViewport) throw new Error(`No settled restored viewport for terminal ${terminalId}`);
  await expectTerminalConverged(page, terminalId, {
    cols: restoredViewport.cols,
    rows: restoredViewport.rows,
    pixelWidth: restoredViewport.pixelWidth,
    pixelHeight: restoredViewport.pixelHeight,
  }, { timeout: WAIT_TIMEOUT });

  const restoredSignal = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "sigwinch"
      && entry.source === "signal"
      && typeof entry.sequence === "number"
      && entry.sequence > restoreSequenceFloor
      && entry.rows === restoredViewport.rows
      && entry.cols === restoredViewport.cols,
    { timeoutMs: WAIT_TIMEOUT },
  );
  expect(numberField(restoredSignal, "rows")).toBe(restoredViewport.rows);
  expect(numberField(restoredSignal, "cols")).toBe(restoredViewport.cols);

  await pane.sendInput(`WINCH ${restoredWinchId} 2 ${restoredViewport.rows} ${restoredViewport.cols}`, true);
  await waitForWinchCommand(server, terminalId, restoredWinchId, 2, { rows: restoredViewport.rows, cols: restoredViewport.cols });
  await pane.sendInput(`SIZE ${restoredSizeId}`, true);
  await waitForSize(server, terminalId, restoredSizeId, { cols: restoredViewport.cols, rows: restoredViewport.rows });
  await waitForQuery(page, pane, server, terminalId, restoredQueryId);
  const restoredMarker = await sendPrint(page, pane, server, terminalId, restoredPrintId, "RESTORED");

  const keybar = pane.root.getByRole("navigation", { name: "Terminal keyboard shortcuts", exact: true });
  await expect(keybar).toBeVisible();
  await pane.sendInput(`CAPTURE_INPUT ${captureId} 1`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "capture_input" && entry.id === captureId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT },
  );
  await keybar.getByRole("button", { name: "Esc", exact: true }).click();
  const captured = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "capture_input" && entry.id === captureId && entry.phase === "complete",
    { timeoutMs: WAIT_TIMEOUT },
  );
  expect(captured.payload_base64).toBe(Buffer.from("\u001b", "utf8").toString("base64"));

  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT },
  );
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:ECHO_INPUT:${echoId}:READY]` }, { timeout: WAIT_TIMEOUT });
  await pane.sendInput(echoPayload, true);
  const echo = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT },
  );
  expect(echo.payload_base64).toBe(Buffer.from(echoPayload, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoPayload, "utf8").toString("base64")}]` }, { timeout: WAIT_TIMEOUT });

  const finalPixels = await screenshotRegion(page, pane.xtermHost);
  await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "v13-restored-marker-crop",
  });
  expect(beforeMarker).not.toBe(restoredMarker);
  expect(openMarker).not.toBe(restoredMarker);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "v13-restored-terminal-crop",
  });
  expect(finalPixels.width).toBeGreaterThan(0);
  expect(finalPixels.height).toBeGreaterThan(0);

  const events = await pane.events();
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  const openSentEvents = events.filter((event) => event.id > openEventFloor && event.id <= restoreEventFloor && isSentViewportEvent(event, openSettled.sentViewport!));
  const restoreSentEvents = events.filter((event) => event.id > restoreEventFloor && isSentViewportEvent(event, restoredSettled.sentViewport!));
  expect(openSentEvents).toHaveLength(1);
  expect(restoreSentEvents).toHaveLength(1);

  const transcript = await server.readTranscript(terminalId);
  const openSignals = transcript.filter((entry) => entry.event === "sigwinch"
    && entry.source === "signal"
    && typeof entry.sequence === "number"
    && entry.sequence > openSequenceFloor
    && entry.sequence <= restoreSequenceFloor
    && entry.rows === openViewport.rows
    && entry.cols === openViewport.cols);
  const restoredSignals = transcript.filter((entry) => entry.event === "sigwinch"
    && entry.source === "signal"
    && typeof entry.sequence === "number"
    && entry.sequence > restoreSequenceFloor
    && entry.rows === restoredViewport.rows
    && entry.cols === restoredViewport.cols);
  expect(openSignals).toHaveLength(1);
  expect(restoredSignals).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "query_complete" && [beforeQueryId, openQueryId, restoredQueryId].includes(String(entry.id)))).toHaveLength(3);
  expect(transcript.filter((entry) => entry.event === "print" && [beforePrintId, openPrintId, restoredPrintId].includes(String(entry.id)))).toHaveLength(3);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);

  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT });
  expect(invariantReport.violations).toEqual([]);
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT });
  const final = await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT });
  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.cols).toBe(restoredViewport.cols);
  expect(final.rows).toBe(restoredViewport.rows);
  expect(final.serverViewport?.cols).toBe(restoredViewport.cols);
  expect(final.serverViewport?.rows).toBe(restoredViewport.rows);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  expect(final.acceptingInput).toBe(true);
  expect(browserErrors).toEqual([]);

  page.off("pageerror", onPageError);
  page.off("console", onConsole);
});
