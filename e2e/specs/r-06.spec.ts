import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const WAIT_TIMEOUT_MS = 45_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
  __R06_PAGE_LIFECYCLE__?: {
    readonly events: readonly LifecycleEvent[];
  };
  __r06RecordLifecycle?: (event: LifecycleEvent) => void;
};

interface LifecycleEvent {
  readonly id: number;
  readonly type: "pageshow" | "pagehide";
  readonly persisted: boolean;
  readonly url: string;
  readonly timestamp: number;
}

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly createdAt: number;
  readonly clients: number;
}

interface LifecycleProbe {
  readonly events: readonly LifecycleEvent[];
  waitFor(type: LifecycleEvent["type"], afterIndex: number): Promise<LifecycleEvent>;
}


interface LifecycleWaiter {
  readonly type: LifecycleEvent["type"];
  readonly afterIndex: number;
  readonly resolve: (event: LifecycleEvent) => void;
  readonly timer: NodeJS.Timeout;
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function runTag(testId: string, workerIndex: number, parallelIndex: number, retry: number, repeatEachIndex: number): string {
  return `R06-${testId}-${workerIndex}-${parallelIndex}-${retry}-${repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
}

async function installLifecycleProbe(page: Page): Promise<LifecycleProbe> {
  const events: LifecycleEvent[] = [];
  const waiters = new Set<LifecycleWaiter>();

  const waitFor = (type: LifecycleEvent["type"], afterIndex: number): Promise<LifecycleEvent> => {
    const existing = events.slice(afterIndex).find((event) => event.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise<LifecycleEvent>((resolve, reject) => {
      const waiter: LifecycleWaiter = {
        type,
        afterIndex,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${type} page lifecycle event`));
        }, WAIT_TIMEOUT_MS),
      };
      waiters.add(waiter);
    });
  };
  await page.exposeFunction("__r06RecordLifecycle", (event: LifecycleEvent) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.type !== event.type || events.length - 1 < waiter.afterIndex) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  });
  await page.addInitScript(() => {
    const lifecycleEvents: LifecycleEvent[] = [];
    const target = window as E2EWindow;
    const record = (type: LifecycleEvent["type"], persisted: boolean): void => {
      const event: LifecycleEvent = {
        id: lifecycleEvents.length,
        type,
        persisted,
        url: window.location.href,
        timestamp: Date.now(),
      };
      lifecycleEvents.push(event);
      const bridge = target.__r06RecordLifecycle;
      if (bridge) void bridge(event);
    };
    Object.defineProperty(target, "__R06_PAGE_LIFECYCLE__", {
      configurable: true,
      value: { events: lifecycleEvents },
    });
    window.addEventListener("pageshow", (event) => record("pageshow", event.persisted));
    window.addEventListener("pagehide", (event) => record("pagehide", event.persisted));
  });

  return { events, waitFor };
}

async function waitForSettledTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.serverViewport;
      const synchronized = snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget;
      return snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.acceptingInput
        && viewport !== undefined
        && viewport.cols === snapshot.cols
        && viewport.rows === snapshot.rows
        && viewport.pixelWidth === snapshot.pixelWidth
        && viewport.pixelHeight === snapshot.pixelHeight
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
        && synchronized;
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS, acknowledgementLimit: TERMINAL_ACK_BYTES });
}

async function waitForRenderedMarker(
  page: Page,
  terminalId: string,
  markerText: string,
  previousRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, text, renderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > renderCount
      && snapshot.xterm.text.includes(text)
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, text: markerText, renderCount: previousRenderCount, timeout: WAIT_TIMEOUT_MS });
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

function connectionOpenGenerations(events: readonly NetworkFaultEvent[], terminalId: string): number[] {
  return events
    .filter((event) => event.type === "connection-open" && event.terminalId === terminalId && event.generation !== undefined)
    .map((event) => event.generation as number);
}

function connectionClosedGenerations(events: readonly NetworkFaultEvent[], terminalId: string): number[] {
  return events
    .filter((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation !== undefined
    ))
    .map((event) => event.generation as number);
}

function activeProxyGenerations(events: readonly NetworkFaultEvent[], terminalId: string): number[] {
  const closed = new Set(connectionClosedGenerations(events, terminalId));
  return [...new Set(connectionOpenGenerations(events, terminalId).filter((generation) => !closed.has(generation)))];
}

function expectMarkerExactlyOnce(snapshot: E2ETerminalSnapshot, expected: string): void {
  const occurrences = snapshot.xterm.text.split(expected).length - 1;
  expect(occurrences, `marker ${expected} must appear exactly once in the terminal model`).toBe(1);
}

function expectNoBrowserErrors(errors: readonly { readonly kind: string; readonly message: string }[]): void {
  expect(errors.filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ))).toEqual([]);
}

test("R-06 Back-forward cache and pageshow/pagehide @p1 @nightly @lifecycle @bfcache", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const lifecycle = await installLifecycleProbe(page);
  let awayPage: Page | undefined;
  let awayErrors: BrowserErrorCollector | undefined;

  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const mountPromise = page.evaluate(async (timeout) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, WAIT_TIMEOUT_MS);
    const createResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.pathname === "/api/terminals";
    });
    await workbench.createTerminal();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const created = await createResponse.json() as { readonly id: string; readonly name: string };
    expect(created.id).not.toBe("");
    const mounted = await mountPromise;
    expect(mounted.terminalId).toBe(created.id);
    const terminalId = created.id;
    const pane = workbench.terminal(terminalId, created.name);
    await pane.expectVisible();

    const initial = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    expect(initial.socketState).toBe("connected");
    expect(initial.activeSocketCount).toBe(1);
    expect(initial.socket.activeCount).toBe(1);
    expect(initial.acceptingInput).toBe(true);
    expect(initial.gridEpoch).toEqual(expect.any(Number));
    expect(initial.receivedSequence).toEqual(expect.any(Number));
    expect(initial.committedSequence).toEqual(expect.any(Number));
    expect(initial.serverViewport).toBeDefined();
    expect(initial.serverViewport?.cols).toBe(initial.cols);
    expect(initial.serverViewport?.rows).toBe(initial.rows);
    expect(initial.serverViewport?.pixelWidth).toBe(initial.pixelWidth);
    expect(initial.serverViewport?.pixelHeight).toBe(initial.pixelHeight);

    const tag = runTag(testInfo.testId, testInfo.workerIndex, testInfo.parallelIndex, testInfo.retry, testInfo.repeatEachIndex);
    const readyId = `${tag}-READY`;
    const beforeId = `${tag}-BEFORE`;
    const beforeText = `${tag}-BEFORE-TEXT`;
    const awayId = `${tag}-AWAY`;
    const awayText = `${tag}-AWAY-TEXT`;
    const afterId = `${tag}-AFTER`;
    const afterText = `${tag}-AFTER-TEXT`;
    const echoId = `${tag}-INPUT`;
    const echoText = `${tag}-CONTINUED-INPUT`;
    const sizeId = `${tag}-SIZE`;
    const readyMarker = marker("READY", readyId);
    const beforeMarker = marker("PRINT", beforeId, beforeText);
    const awayMarker = marker("PRINT", awayId, awayText);
    const afterMarker = marker("PRINT", afterId, afterText);
    const echoMarker = marker("ECHO_INPUT", echoId, Buffer.from(echoText, "utf8").toString("base64"));
    const sizeMarkerPrefix = marker("SIZE", sizeId);

    const readyBefore = await pane.snapshot();
    if (!readyBefore) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
    const readyRendered = waitForRenderedMarker(page, terminalId, readyMarker, readyBefore.renderCount);
    await pane.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await readyRendered;

    const beforePixels = await screenshotRegion(page, pane.xtermHost);
    const beforeSnapshot = await pane.snapshot();
    if (!beforeSnapshot) throw new Error(`No diagnostics snapshot before navigation for terminal ${terminalId}`);
    const beforeRendered = waitForRenderedMarker(page, terminalId, beforeMarker, beforeSnapshot.renderCount);
    await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "print" && entry.id === beforeId && entry.text === beforeText
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await beforeRendered;
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: "r-06-before-navigation",
    });
    const beforeNavigationPixels = await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-06-before-navigation-marker",
    });
    expect(beforeNavigationPixels.after.width).toBe(beforePixels.width);
    expect(beforeNavigationPixels.after.height).toBe(beforePixels.height);

    const beforeTerminal = await readTerminal(page, terminalId);
    expect(beforeTerminal.id).toBe(terminalId);
    expect(beforeTerminal.status).toBe("running");
    expect(beforeTerminal.pid).not.toBeNull();
    expect(beforeTerminal.clients).toBe(1);
    const initialProxyOpen = [...faultController.events].reverse().find((event) => (
      event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined
    ));
    if (!initialProxyOpen || initialProxyOpen.generation === undefined) {
      throw new Error(`initial proxy connection did not expose a generation for terminal ${terminalId}`);
    }
    const initialProxyGeneration = initialProxyOpen.generation;
    const initialEvents = await terminalEvents(page, terminalId);
    expect(initialEvents.filter((event) => event.type === "error")).toEqual([]);

    const pagehideFloor = lifecycle.events.length;
    const pagehidePromise = lifecycle.waitFor("pagehide", pagehideFloor);
    await page.goto("about:blank");
    const pagehide = await pagehidePromise;
    expect(pagehide.type).toBe("pagehide");
    expect(pagehide.url).toContain(new URL(baseURL).origin);
    expect(typeof pagehide.persisted).toBe("boolean");

    awayPage = await page.context().newPage();
    awayErrors = installBrowserErrorCollectors(awayPage);
    await awayPage.goto(baseURL);
    const awayLogin = new LoginPage(awayPage);
    if (await awayLogin.password.isVisible()) await awayLogin.login();
    const awayWorkbench = new WorkbenchPage(awayPage);
    await awayWorkbench.expectVisible();
    const awayPane = await awayWorkbench.openTerminal({ id: terminalId, name: created.name });
    await awayPane.expectVisible();
    await awayPane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
    const awayProxyOpen = await faultController.waitFor((event) => (
      event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined
      && event.generation > initialProxyGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    if (awayProxyOpen.generation === undefined) throw new Error("away-page proxy connection did not expose a generation");

    await awayPane.sendInput(`PRINT ${awayId} ${awayText}`, true);
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "print" && entry.id === awayId && entry.text === awayText
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    const awayClosePromise = faultController.waitFor((event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === awayProxyOpen.generation
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await awayPage.close();
    awayPage = undefined;
    await awayClosePromise;

    const pageshowFloor = lifecycle.events.length;
    const pageshowPromise = lifecycle.waitFor("pageshow", pageshowFloor);
    await page.goBack({ waitUntil: "commit" });
    const pageshow = await pageshowPromise;
    expect(pageshow.type).toBe("pageshow");
    expect(pageshow.url).toContain(new URL(baseURL).origin);
    expect(typeof pageshow.persisted).toBe("boolean");
    testInfo.annotations.push({
      type: "bfcache-capability",
      description: `pagehide.persisted=${pagehide.persisted}; pageshow.persisted=${pageshow.persisted}`,
    });
    if (pageshow.persisted) expect(pagehide.persisted).toBe(true);
    if (!pageshow.persisted) {
      await faultController.waitFor((event) => (
        (event.type === "connection-closed" || event.type === "connection-terminated")
        && event.terminalId === terminalId
        && event.generation === initialProxyGeneration
      ), { timeoutMs: WAIT_TIMEOUT_MS });
    }

    const restoredWorkbench = new WorkbenchPage(page);
    await restoredWorkbench.expectVisible();
    const restoredRegion = page.locator(`[data-terminal-id="${terminalId.replace(/["\\]/g, "\\$&")}"]`).first();
    if (await restoredRegion.count() === 0) await restoredWorkbench.openTerminal({ id: terminalId, name: created.name });
    const restoredPane = restoredWorkbench.terminal(terminalId, created.name);
    await restoredPane.expectVisible();
    const restored = await waitForSettledTerminal(page, terminalId);
    expect(restored.socketState).toBe("connected");
    expect(restored.activeSocketCount).toBe(1);
    expect(restored.socket.activeCount).toBe(1);
    expect(restored.acceptingInput).toBe(true);
    expect(restored.gridEpoch).toBe(initial.gridEpoch);
    expect(restored.serverViewport).toBeDefined();
    expect(restored.serverViewport?.cols).toBe(restored.cols);
    expect(restored.serverViewport?.rows).toBe(restored.rows);
    expect(restored.serverViewport?.pixelWidth).toBe(restored.pixelWidth);
    expect(restored.serverViewport?.pixelHeight).toBe(restored.pixelHeight);
    expect(restored.xterm.text).toContain(awayMarker);
    expectMarkerExactlyOnce(restored, beforeMarker);
    expectMarkerExactlyOnce(restored, awayMarker);
    expect(restored.renderCount).toBeGreaterThan(0);
    expect(restored.rendererState.kind).toBe(restored.renderer);
    await expectTerminalConverged(page, terminalId, {
      cols: initial.cols,
      rows: initial.rows,
      pixelWidth: initial.pixelWidth,
      pixelHeight: initial.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, restoredPane.xtermHost, {
      testInfo,
      artifactName: "r-06-after-pageshow",
    });
    const afterAwayPixels = await expectKnownMarkerChanged(page, restoredPane.xtermHost, beforeNavigationPixels.after, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-06-away-marker",
    });
    expect(afterAwayPixels.after.width).toBe(beforeNavigationPixels.after.width);
    expect(afterAwayPixels.after.height).toBe(beforeNavigationPixels.after.height);

    const afterSnapshot = await restoredPane.snapshot();
    if (!afterSnapshot) throw new Error(`No diagnostics snapshot after pageshow for terminal ${terminalId}`);
    const afterRendered = waitForRenderedMarker(page, terminalId, afterMarker, afterSnapshot.renderCount);
    await restoredPane.sendInput(`PRINT ${afterId} ${afterText}`, true);
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "print" && entry.id === afterId && entry.text === afterText
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await afterRendered;
    const afterPrintPixels = await expectKnownMarkerChanged(page, restoredPane.xtermHost, afterAwayPixels.after, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-06-after-marker",
    });
    await expectTerminalNonBlank(page, restoredPane.xtermHost, {
      testInfo,
      artifactName: "r-06-after-print",
    });

    const inputBefore = await restoredPane.snapshot();
    if (!inputBefore) throw new Error(`No diagnostics snapshot before continued input render for terminal ${terminalId}`);
    const inputRendered = waitForRenderedMarker(page, terminalId, echoMarker, inputBefore.renderCount);
    const echoArmPromise = server.waitForTranscript(terminalId, (entry) => (
      entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await restoredPane.sendInput(`ECHO_INPUT ${echoId}`, true);
    await echoArmPromise;
    const echoPayloadPromise = server.waitForTranscript(terminalId, (entry) => (
      entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(echoText, "utf8").toString("base64")
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await restoredPane.sendInput(echoText, true);
    await echoPayloadPromise;
    await expectTerminalBuffer(page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await inputRendered;
    const afterInputPixels = await expectKnownMarkerChanged(page, restoredPane.xtermHost, afterPrintPixels.after, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "r-06-continued-input-marker",
    });
    expect(afterInputPixels.after.width).toBe(afterPrintPixels.after.width);
    expect(afterInputPixels.after.height).toBe(afterPrintPixels.after.height);

    const sizeBefore = await restoredPane.snapshot();
    if (!sizeBefore) throw new Error(`No diagnostics snapshot before PTY size query for terminal ${terminalId}`);
    const sizeRendered = waitForRenderedMarker(page, terminalId, sizeMarkerPrefix, sizeBefore.renderCount);
    await restoredPane.sendInput(`SIZE ${sizeId}`, true);
    const size = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number; pixel_width: number; pixel_height: number; source: string }>(
      terminalId,
      (entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(size.rows).toBe(restored.rows);
    expect(size.cols).toBe(restored.cols);
    expect(size.pixel_width).toBe(restored.pixelWidth);
    expect(size.pixel_height).toBe(restored.pixelHeight);
    await expectTerminalBuffer(page, terminalId, { contains: sizeMarkerPrefix, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await sizeRendered;

    const final = await waitForSettledTerminal(page, terminalId);
    expect(final.socketState).toBe("connected");
    expect(final.activeSocketCount).toBe(1);
    expect(final.socket.activeCount).toBe(1);
    expect(final.acceptingInput).toBe(true);
    expect(final.gridEpoch).toBe(initial.gridEpoch);
    expect(final.serverViewport).toBeDefined();
    expect(final.serverViewport?.cols).toBe(final.cols);
    expect(final.serverViewport?.rows).toBe(final.rows);
    expect(final.serverViewport?.pixelWidth).toBe(final.pixelWidth);
    expect(final.serverViewport?.pixelHeight).toBe(final.pixelHeight);
    expect(final.renderCount).toBeGreaterThan(restored.renderCount);
    expect(final.rendererState.kind).toBe(final.renderer);
    expect(final.committedSequence).toBeGreaterThan(initial.committedSequence ?? -1);
    expect(final.receivedSequence).toBeGreaterThanOrEqual(final.committedSequence ?? -1);
    expectMarkerExactlyOnce(final, readyMarker);
    expectMarkerExactlyOnce(final, beforeMarker);
    expectMarkerExactlyOnce(final, awayMarker);
    expectMarkerExactlyOnce(final, afterMarker);
    expectMarkerExactlyOnce(final, echoMarker);
    expectMarkerExactlyOnce(final, sizeMarkerPrefix);
    await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: beforeMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: awayMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: afterMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalBuffer(page, terminalId, { contains: sizeMarkerPrefix, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

    const lifecycleLog = await page.evaluate(() => {
      const lifecycle = (window as E2EWindow).__R06_PAGE_LIFECYCLE__;
      return lifecycle ? [...lifecycle.events] : [];
    });
    expect(lifecycleLog.some((event) => event.type === "pageshow")).toBe(true);
    if (pageshow.persisted) {
      expect(restored.socketGeneration).toBe(initial.socketGeneration);
      expect(restored.renderer).toBe(initial.renderer);
      expect(restored.webglLoadCount).toBe(initial.webglLoadCount);
      expect(restored.contextLossCount).toBe(initial.contextLossCount);
      expect(restored.fallbackCount).toBe(initial.fallbackCount);
    } else {
      expect(restored.socketGeneration).toBeGreaterThanOrEqual(1);
      expect(restored.rendererState.kind).toBe(restored.renderer);
      expect(restored.renderCount).toBeGreaterThan(0);
    }

    const finalEvents = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(finalEvents);
    const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.violations).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "socket-stale")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "state" && ["disconnected", "recovering"].includes(String(event.data.state)))).toHaveLength(0);
    expect(finalEvents.filter((event) => event.type === "render").length).toBeGreaterThan(0);
    expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "socket-open")).toHaveLength(1);
    expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);

    const networkEvents = faultController.events.filter((event) => event.terminalId === terminalId);
    expect(networkEvents.filter((event) => event.type === "socket-error" || event.type === "malformed-frame")).toEqual([]);
    const openGenerations = connectionOpenGenerations(networkEvents, terminalId);
    const closedGenerations = connectionClosedGenerations(networkEvents, terminalId);
    expect(openGenerations).toContain(initialProxyGeneration);
    expect(openGenerations).toContain(awayProxyOpen.generation);
    if (pageshow.persisted) {
      expect(closedGenerations).not.toContain(initialProxyGeneration);
      expect(openGenerations.filter((generation) => generation > (awayProxyOpen.generation ?? 0))).toHaveLength(0);
    } else {
      expect(closedGenerations).toContain(initialProxyGeneration);
      const recreatedGenerations = openGenerations.filter((generation) => generation > (awayProxyOpen.generation ?? 0));
      expect(recreatedGenerations).toHaveLength(1);
      expect(closedGenerations).not.toContain(recreatedGenerations[0]);
    }
    expect(activeProxyGenerations(networkEvents, terminalId)).toHaveLength(1);

    const finalTerminal = await readTerminal(page, terminalId);
    expect(finalTerminal.id).toBe(beforeTerminal.id);
    expect(finalTerminal.name).toBe(beforeTerminal.name);
    expect(finalTerminal.createdAt).toBe(beforeTerminal.createdAt);
    expect(finalTerminal.status).toBe("running");
    expect(finalTerminal.pid).toBe(beforeTerminal.pid);
    expect(finalTerminal.clients).toBe(1);

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === beforeId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === awayId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === afterId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "size" && entry.id === sizeId && entry.source === "ioctl")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
    expect(transcript.filter((entry) => entry.event === "exit")).toEqual([]);
    const writes = transcript.filter((entry) => entry.event === "write");
    expect(writes.filter((entry) => entry.text === `${beforeMarker}\n`)).toHaveLength(1);
    expect(writes.filter((entry) => entry.text === `${awayMarker}\n`)).toHaveLength(1);
    expect(writes.filter((entry) => entry.text === `${afterMarker}\n`)).toHaveLength(1);
    expect(writes.filter((entry) => entry.text === `${echoMarker}\n`)).toHaveLength(1);
    const winches = transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
    expect(winches.length).toBeGreaterThan(0);
    let previousWinchSequence = 0;
    for (const winch of winches) {
      const signalSequence = Number(winch.signal_sequence);
      expect(signalSequence).toBeGreaterThan(previousWinchSequence);
      previousWinchSequence = signalSequence;
    }
    const latestWinch = winches.at(-1);
    expect(latestWinch?.rows).toBe(final.rows);
    expect(latestWinch?.cols).toBe(final.cols);

    expectNoBrowserErrors([...browserErrors(), ...(awayErrors ? awayErrors() : [])]);
  } finally {
    awayErrors?.dispose();
    if (awayPage && !awayPage.isClosed()) await awayPage.close();
    browserErrors.dispose();
  }
});
