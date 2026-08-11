import { expect, test } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_VIEWPORT_SETTLE_MS } from "../../src/client/lib/terminal-viewport.js";

const WAIT_TIMEOUT_MS = 15_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type HostSize = {
  readonly width: number;
  readonly height: number;
};

const sameViewport = (first: E2EViewport | undefined, second: E2EViewport | undefined): boolean => (
  first !== undefined
  && second !== undefined
  && first.cols === second.cols
  && first.rows === second.rows
  && first.pixelWidth === second.pixelWidth
  && first.pixelHeight === second.pixelHeight
);

const differentViewport = (first: E2EViewport, second: E2EViewport): boolean => !sameViewport(first, second);

async function waitForProposedViewport(
  page: Page,
  terminalId: string,
  previous: E2EViewport | undefined,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, previous, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => {
      if (event.type !== "viewport" || event.data.source !== "proposed") return false;
      const proposed = event.snapshot.proposedViewport;
      if (!proposed) return false;
      return previous === undefined || !(
        proposed.cols === previous.cols
        && proposed.rows === previous.rows
        && proposed.pixelWidth === previous.pixelWidth
        && proposed.pixelHeight === previous.pixelHeight
      );
    }, { timeout });
  }, { id: terminalId, previous, timeout: WAIT_TIMEOUT_MS });
}

async function waitForHostResize(
  page: Page,
  terminalId: string,
  previous: HostSize,
): Promise<HostSize> {
  return page.evaluate(({ id, previous }) => new Promise<HostSize>((resolve) => {
    const pane = [...document.querySelectorAll<HTMLElement>("[data-terminal-id]")]
      .find((element) => element.dataset.terminalId === id);
    const host = pane?.querySelector<HTMLElement>(".xterm-host");
    if (!host) throw new Error(`terminal ${id} has no xterm host`);
    const read = (): HostSize => {
      const rect = host.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    const changed = (next: HostSize): boolean => (
      next.width > 0
      && next.height > 0
      && (Math.abs(next.width - previous.width) > 1 || Math.abs(next.height - previous.height) > 1)
    );
    const initial = read();
    if (changed(initial)) {
      resolve(initial);
      return;
    }
    const observer = new ResizeObserver(() => {
      const next = read();
      if (!changed(next)) return;
      observer.disconnect();
      resolve(next);
    });
    observer.observe(host);
  }), { id: terminalId, previous });
}

function cellsFromEvent(event: E2ETerminalEvent): { readonly cols: number; readonly rows: number } | undefined {
  const cols = event.data.cols;
  const rows = event.data.rows;
  return typeof cols === "number" && typeof rows === "number" ? { cols, rows } : undefined;
}

test("V-02 Hide during pending settled resize @nightly", async ({ page, server }, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const firstMount = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent("mount", { timeout });
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const firstMounted = await firstMount;
  const firstId = firstMounted.terminalId;
  const firstName = (await page.locator(".sidebar .terminal-row .terminal-title").first().innerText()).trim();
  if (!firstName) throw new Error("first terminal has no accessible name");
  const first = workbench.terminal(firstId, firstName);
  await first.expectVisible();

  const initial = await expectTerminalSynchronized(page, firstId, { timeout: WAIT_TIMEOUT_MS });
  const baseline = await expectTerminalConverged(page, firstId, {
    cols: initial.cols,
    rows: initial.rows,
  }, { timeout: WAIT_TIMEOUT_MS });
  const baselineViewport = baseline.sentViewport ?? baseline.urlViewport ?? baseline.proposedViewport ?? baseline.viewport;
  if (!baselineViewport) throw new Error("first terminal has no baseline viewport diagnostics");

  const readyId = `V02-READY-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  await first.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(firstId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });

  const initialMarker = `V02-BEFORE-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const initialScreen = first.xtermHost.locator(".xterm-screen");
  const beforeInitialMarker = await screenshotRegion(page, initialScreen);
  await first.sendInput(`PRINT ${initialMarker} stable`, true);
  await server.waitForTranscript(firstId, (entry) => entry.event === "print" && entry.id === initialMarker, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, firstId, {
    contains: `[E2E:PRINT:${initialMarker}:stable]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, initialScreen, beforeInitialMarker, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "v-02-initial-marker",
  });
  await expectTerminalNonBlank(page, initialScreen, {
    testInfo,
    artifactName: "v-02-initial-terminal",
  });

  const holdToken = `V02-HOLD-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  await first.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(firstId, (entry) => entry.event === "hold" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });

  const browserBefore = page.viewportSize();
  if (!browserBefore) throw new Error("Playwright did not provide a browser viewport");
  const pendingBrowser = {
    width: Math.max(1_000, browserBefore.width - 120),
    height: Math.max(700, browserBefore.height),
  };
  const revealedBrowser = {
    width: Math.max(800, pendingBrowser.width - 180),
    height: Math.max(560, pendingBrowser.height - 80),
  };
  if (pendingBrowser.width === revealedBrowser.width && pendingBrowser.height === revealedBrowser.height) {
    throw new Error("pending and revealed browser geometries must differ");
  }

  await page.clock.install();
  const resizeBefore = await first.xtermHost.boundingBox();
  if (!resizeBefore) throw new Error("first terminal xterm host disappeared before pending resize");
  const pendingResize = waitForHostResize(page, firstId, {
    width: resizeBefore.width,
    height: resizeBefore.height,
  });
  const eventsBeforePending = await first.events();
  const sentBeforePending = eventsBeforePending.filter((event) => event.type === "viewport" && event.data.source === "sent").length;
  await workbench.setViewport(pendingBrowser.width, pendingBrowser.height);
  const pendingHost = await pendingResize;
  expect(Math.abs(pendingHost.width - resizeBefore.width) > 1 || Math.abs(pendingHost.height - resizeBefore.height) > 1).toBe(true);

  const secondMount = page.evaluate(async ({ excludedId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount" && event.terminalId !== excludedId, { timeout });
  }, { excludedId: firstId, timeout: WAIT_TIMEOUT_MS });
  const hidden = page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.mounted && snapshot.cached && !snapshot.visible, { timeout });
  }, { id: firstId, timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const secondMounted = await secondMount;
  const hiddenSnapshot = await hidden;
  const secondId = secondMounted.terminalId;
  const second = workbench.terminal(secondId);
  await second.expectVisible();
  await expectTerminalSynchronized(page, secondId, { timeout: WAIT_TIMEOUT_MS });
  expect(hiddenSnapshot.lifecycle.mounted).toBe(true);
  expect(hiddenSnapshot.lifecycle.cached).toBe(true);
  expect(hiddenSnapshot.lifecycle.visible).toBe(false);

  await page.clock.runFor(TERMINAL_VIEWPORT_SETTLE_MS);
  const hiddenEvents = await first.events();
  const hiddenSent = hiddenEvents.filter((event) => event.type === "viewport" && event.data.source === "sent");
  expect(hiddenSent).toHaveLength(sentBeforePending);
  expect(hiddenEvents.filter((event) => event.type === "error")).toHaveLength(0);

  const secondBefore = await second.xtermHost.boundingBox();
  if (!secondBefore) throw new Error("second terminal xterm host has no geometry");
  const secondResize = waitForHostResize(page, secondId, {
    width: secondBefore.width,
    height: secondBefore.height,
  });
  await workbench.setViewport(revealedBrowser.width, revealedBrowser.height);
  const secondRevealedHost = await secondResize;
  expect(Math.abs(secondRevealedHost.width - secondBefore.width) > 1 || Math.abs(secondRevealedHost.height - secondBefore.height) > 1).toBe(true);
  await page.clock.runFor(TERMINAL_VIEWPORT_SETTLE_MS);

  const revealedVisible = page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.mounted && snapshot.visible && !snapshot.cached, { timeout });
  }, { id: firstId, timeout: WAIT_TIMEOUT_MS });
  const revealedHostWait = waitForHostResize(page, firstId, { width: 0, height: 0 });
  await workbench.openTerminal(firstName);
  const revealedVisibleSnapshot = await revealedVisible;
  const revealedHost = await revealedHostWait;
  expect(revealedVisibleSnapshot.lifecycle.visible).toBe(true);
  expect(revealedVisibleSnapshot.lifecycle.cached).toBe(false);
  expect(revealedHost.width).toBeGreaterThan(0);
  expect(revealedHost.height).toBeGreaterThan(0);

  const revealedProposedPromise = waitForProposedViewport(page, firstId, baselineViewport);
  await page.clock.runFor(TERMINAL_VIEWPORT_SETTLE_MS);
  const revealedProposedEvent = await revealedProposedPromise;
  const revealedViewport = revealedProposedEvent.snapshot.proposedViewport;
  if (!revealedViewport) throw new Error("revealed viewport proposal is missing");
  expect(differentViewport(revealedViewport, baselineViewport)).toBe(true);
  expect(Math.abs(pendingHost.width - revealedHost.width) > 1 || Math.abs(pendingHost.height - revealedHost.height) > 1).toBe(true);

  const revealedSentPromise = page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === "viewport"
      && event.data.source === "sent"
      && event.snapshot.sentViewport?.cols === expected.cols
      && event.snapshot.sentViewport?.rows === expected.rows
      && event.snapshot.sentViewport?.pixelWidth === expected.pixelWidth
      && event.snapshot.sentViewport?.pixelHeight === expected.pixelHeight
    ), { timeout });
  }, { id: firstId, expected: revealedViewport, timeout: WAIT_TIMEOUT_MS });
  const revealedSentEvent = await revealedSentPromise;
  expect(revealedSentEvent.snapshot.sentViewport).toEqual(revealedViewport);

  const final = await page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.visible
      && !snapshot.cached
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.cols === expected.cols
      && snapshot.rows === expected.rows
      && snapshot.pixelWidth === expected.pixelWidth
      && snapshot.pixelHeight === expected.pixelHeight
      && snapshot.proposedViewport?.cols === expected.cols
      && snapshot.proposedViewport?.rows === expected.rows
      && snapshot.proposedViewport?.pixelWidth === expected.pixelWidth
      && snapshot.proposedViewport?.pixelHeight === expected.pixelHeight
      && snapshot.desiredViewport?.cols === expected.cols
      && snapshot.desiredViewport?.rows === expected.rows
      && snapshot.desiredViewport?.pixelWidth === expected.pixelWidth
      && snapshot.desiredViewport?.pixelHeight === expected.pixelHeight
      && snapshot.sentViewport?.cols === expected.cols
      && snapshot.sentViewport?.rows === expected.rows
      && snapshot.sentViewport?.pixelWidth === expected.pixelWidth
      && snapshot.sentViewport?.pixelHeight === expected.pixelHeight
      && snapshot.serverViewport?.cols === expected.cols
      && snapshot.serverViewport?.rows === expected.rows
      && snapshot.serverViewport?.pixelWidth === expected.pixelWidth
      && snapshot.serverViewport?.pixelHeight === expected.pixelHeight
    ), { timeout });
  }, { id: firstId, expected: revealedViewport, timeout: WAIT_TIMEOUT_MS });

  const selectedEvents = await first.events();
  expect(selectedEvents.filter((event) => event.type === "viewport" && event.data.source === "sent").some((event) => sameViewport(event.snapshot.sentViewport, revealedViewport))).toBe(true);
  expect(selectedEvents.filter((event) => event.type === "size").some((event) => {
    const cells = cellsFromEvent(event);
    return cells?.cols === revealedViewport.cols && cells.rows === revealedViewport.rows;
  })).toBe(true);
  expect(selectedEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(selectedEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);

  const screen = first.xtermHost.locator(".xterm-screen");
  await expect(screen).toBeVisible();
  const renderedGeometry = await screen.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const canvas = element.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas) throw new Error("xterm screen has no compositor canvas");
    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      devicePixelRatio: window.devicePixelRatio,
    };
  });
  expect(Math.abs(final.pixelWidth - Math.round(renderedGeometry.cssWidth))).toBeLessThanOrEqual(1);
  expect(Math.abs(final.pixelHeight - Math.round(renderedGeometry.cssHeight))).toBeLessThanOrEqual(1);
  expect(Math.abs(renderedGeometry.canvasWidth - Math.round(renderedGeometry.cssWidth * renderedGeometry.devicePixelRatio))).toBeLessThanOrEqual(1);
  expect(Math.abs(renderedGeometry.canvasHeight - Math.round(renderedGeometry.cssHeight * renderedGeometry.devicePixelRatio))).toBeLessThanOrEqual(1);

  const release = `RELEASE ${holdToken}`;
  await first.sendInput(release, true);
  await server.waitForTranscript(firstId, (entry) => entry.event === "release" && entry.token === holdToken, { timeoutMs: WAIT_TIMEOUT_MS });

  const sizeId = `V02-SIZE-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  await first.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(firstId, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
  expect(size.cols).toBe(final.cols);
  expect(size.rows).toBe(final.rows);
  expect(size.pixel_width).toBe(final.pixelWidth);
  expect(size.pixel_height).toBe(final.pixelHeight);

  const winchId = `V02-WINCH-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const winchSequence = 7001;
  await first.sendInput(`WINCH ${winchId} ${winchSequence} ${final.rows} ${final.cols}`, true);
  const winch = await server.waitForTranscript(firstId, (entry) => entry.event === "sigwinch" && entry.id === winchId, { timeoutMs: WAIT_TIMEOUT_MS });
  expect(winch.source).toBe("command");
  expect(winch.signal_sequence).toBe(winchSequence);
  expect(winch.rows).toBe(final.rows);
  expect(winch.cols).toBe(final.cols);
  expect(winch.actual_rows).toBe(final.rows);
  expect(winch.actual_cols).toBe(final.cols);

  const finalMarker = `V02-AFTER-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const beforeFinalMarker = await screenshotRegion(page, screen);
  await first.sendInput(`PRINT ${finalMarker} revealed`, true);
  await server.waitForTranscript(firstId, (entry) => entry.event === "print" && entry.id === finalMarker, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, firstId, {
    contains: `[E2E:PRINT:${finalMarker}:revealed]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, screen, beforeFinalMarker, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "v-02-revealed-marker",
  });
  await expectTerminalNonBlank(page, screen, {
    testInfo,
    artifactName: "v-02-revealed-terminal",
  });

  const echoId = `V02-ECHO-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const inputMarker = `V02-CONTINUED-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  await first.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(firstId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await first.sendInput(inputMarker, true);
  const echo = await server.waitForTranscript(firstId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
  expect(echo.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));

  const transcript = await server.readTranscript(firstId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal" && entry.rows === final.rows && entry.cols === final.cols).length).toBeGreaterThan(0);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);

  const connected = await expectConnectedTerminalInvariants(page, firstId, { timeout: WAIT_TIMEOUT_MS });
  assertNoPendingSynchronization(connected.snapshot);
  expect(connected.snapshot.activeSocketCount).toBe(1);
  expect(connected.snapshot.socket.activeCount).toBe(1);
  expect(connected.snapshot.lifecycle.visible).toBe(true);
  expect(connected.snapshot.lifecycle.cached).toBe(false);
  expect(connected.snapshot.lifecycle.acceptingInput).toBe(true);
  expect(connected.snapshot.serverViewport).toEqual(expect.objectContaining({
    cols: final.cols,
    rows: final.rows,
    pixelWidth: final.pixelWidth,
    pixelHeight: final.pixelHeight,
  }));
});
