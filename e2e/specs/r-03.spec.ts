import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { Page } from "@playwright/test";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalInteractive,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalEvent,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const DIAGNOSTICS_TIMEOUT = 30_000;
const TRANSCRIPT_TIMEOUT = 30_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface RendererResources {
  readonly canvasCount: number;
  readonly attachedCanvasCount: number;
  readonly canvasPixels: number;
}

function marker(testId: string, label: string): string {
  const safeTestId = testId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `R03-${safeTestId}-${label}`;
}

async function waitForRendererReady(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => (snapshot.renderer === "webgl" && snapshot.webglLoadCount >= 1) || snapshot.fallbackCount > 0,
      { timeout },
    );
  }, { id: terminalId, timeout: DIAGNOSTICS_TIMEOUT });
}

async function readRendererResources(pane: TerminalPanePage): Promise<RendererResources> {
  return pane.xtermHost.evaluate((host) => {
    const canvases = [...host.querySelectorAll<HTMLCanvasElement>("canvas")];
    return {
      canvasCount: canvases.length,
      attachedCanvasCount: canvases.filter((canvas) => canvas.isConnected).length,
      canvasPixels: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
    };
  });
}

async function requestContextLoss(page: Page, terminalId: string): Promise<"requested" | "unavailable"> {
  return page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api || typeof api.controls.renderer.loseContext !== "function") return "unavailable" as const;
    try {
      api.controls.renderer.loseContext(id);
      return "requested" as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("WEBGL_lose_context is unavailable")) return "unavailable" as const;
      throw error;
    }
  }, terminalId);
}

async function repeatContextLossRequests(page: Page, terminalId: string, count: number): Promise<readonly ("requested" | "unavailable")[]> {
  return page.evaluate(({ id, count }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api || typeof api.controls.renderer.loseContext !== "function") return Array.from({ length: count }, () => "unavailable" as const);
    const results: ("requested" | "unavailable")[] = [];
    for (let index = 0; index < count; index += 1) {
      try {
        api.controls.renderer.loseContext(id);
        results.push("requested");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("WEBGL_lose_context is unavailable")) throw error;
        results.push("unavailable");
      }
    }
    return results;
  }, { id: terminalId, count });
}

async function waitForLossFallback(page: Page, terminalId: string): Promise<{
  readonly loss: E2ETerminalEvent;
  readonly fallback: E2ETerminalEvent;
  readonly snapshot: E2ETerminalSnapshot;
}> {
  const lossPromise = waitForTerminalEvent(page, terminalId, "renderer-context-loss", { timeout: DIAGNOSTICS_TIMEOUT });
  const fallbackPromise = waitForTerminalEvent(page, terminalId, "renderer-fallback", { timeout: DIAGNOSTICS_TIMEOUT });
  const [loss, fallback, snapshot] = await Promise.all([
    lossPromise,
    fallbackPromise,
    page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, (current) => (
        current.renderer === "canvas"
        && current.contextLossCount >= 1
        && current.fallbackCount >= 1
        && current.activeSocketCount === 1
      ), { timeout });
    }, { id: terminalId, timeout: DIAGNOSTICS_TIMEOUT }),
  ]);
  return { loss, fallback, snapshot };
}

function assertNoRendererResourceGrowth(
  before: RendererResources,
  afterFallback: RendererResources,
  afterRepeated: RendererResources,
): void {
  expect(afterRepeated.canvasCount).toBe(afterFallback.canvasCount);
  expect(afterRepeated.attachedCanvasCount).toBe(afterFallback.attachedCanvasCount);
  expect(afterRepeated.canvasPixels).toBe(afterFallback.canvasPixels);
  expect(afterRepeated.canvasCount).toBeLessThanOrEqual(Math.max(before.canvasCount, afterFallback.canvasCount));
  expect(afterRepeated.canvasPixels).toBeLessThanOrEqual(Math.max(before.canvasPixels, afterFallback.canvasPixels));
}

test("R-03 Repeated context loss @p1 @nightly", async ({ page, server, faultController }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.goto("/");
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const region = workbench.editorGrid.locator("[data-terminal-id]").first();
  await expect(region).toBeVisible();
  const terminalId = await region.getAttribute("data-terminal-id");
  expect(terminalId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (!terminalId) throw new Error("created terminal did not expose a stable terminal ID");

  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalInteractive(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  const rendererReady = await waitForRendererReady(page, terminalId);
  expect(rendererReady.activeSocketCount).toBe(1);
  expect(rendererReady.socket.activeCount).toBe(1);
  expect(rendererReady.rendererState.kind).toBe(rendererReady.renderer);

  const readyId = marker(testInfo.testId, "READY");
  const readyTranscript = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: TRANSCRIPT_TIMEOUT },
  );
  await pane.sendInput(`READY ${readyId}`, true);
  await readyTranscript;
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });

  const beforeId = marker(testInfo.testId, "BASELINE");
  const beforeText = marker(testInfo.testId, "BASELINE-VISIBLE");
  const beforePrint = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === beforeId && entry.text === beforeText,
    { timeoutMs: TRANSCRIPT_TIMEOUT },
  );
  await pane.sendInput(`PRINT ${beforeId} ${beforeText}`, true);
  await beforePrint;
  const beforeLine = `[E2E:PRINT:${beforeId}:${beforeText}]`;
  await expectTerminalBuffer(page, terminalId, { contains: beforeLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-03-before-loss",
  });
  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  const beforeSnapshot = await pane.snapshot();
  if (!beforeSnapshot) throw new Error("missing diagnostics snapshot before repeated context loss");
  const beforeResources = await readRendererResources(pane);
  expect(beforeSnapshot.activeSocketCount).toBe(1);
  expect(beforeSnapshot.renderer).toBe(rendererReady.renderer);

  // Hold one real server-to-browser frame at the proxy while the renderer is
  // disrupted. Releasing it after fallback proves the fallback can consume
  // delayed production output rather than only repainting old model state.
  const paused = faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.direction === "server-to-browser"
  ), { timeoutMs: DIAGNOSTICS_TIMEOUT });
  const pauseRule = faultController.pause("server-to-browser", { terminalId });
  await paused;

  const queuedId = marker(testInfo.testId, "QUEUED");
  const queuedText = marker(testInfo.testId, "QUEUED-AFTER-LOSS");
  const queuedPrint = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === queuedId && entry.text === queuedText,
    { timeoutMs: TRANSCRIPT_TIMEOUT },
  );
  await pane.sendInput(`PRINT ${queuedId} ${queuedText}`, true);
  await queuedPrint;

  let afterFallback: E2ETerminalSnapshot;
  let afterFallbackResources: RendererResources;
  if (rendererReady.renderer === "webgl") {
    const firstLossRequest = await requestContextLoss(page, terminalId);
    expect(firstLossRequest).toBe("requested");
    const loss = await waitForLossFallback(page, terminalId);
    expect(loss.loss.type).toBe("renderer-context-loss");
    expect(loss.loss.snapshot.contextLossCount).toBe(1);
    expect(loss.fallback.type).toBe("renderer-fallback");
    expect(loss.fallback.data.reason).toBe("context-loss");
    afterFallback = loss.snapshot;
    afterFallbackResources = await readRendererResources(pane);
    expect(afterFallback.renderer).toBe("canvas");
    expect(afterFallback.contextLossCount).toBe(1);
    expect(afterFallback.fallbackCount).toBe(1);
    expect(afterFallback.webglLoadCount).toBe(beforeSnapshot.webglLoadCount);
    expect(afterFallback.activeSocketCount).toBe(1);
  } else {
    testInfo.annotations.push({
      type: "webgl-context-loss-capability",
      description: "active WebGL renderer unavailable; durable built-in fallback was exercised",
    });
    afterFallback = await pane.snapshot() ?? rendererReady;
    afterFallbackResources = await readRendererResources(pane);
    expect(afterFallback.renderer).not.toBe("webgl");
    expect(afterFallback.activeSocketCount).toBe(1);
  }

  const repeatedRequests = rendererReady.renderer === "webgl"
    ? await repeatContextLossRequests(page, terminalId, 3)
    : [];
  if (rendererReady.renderer === "webgl") {
    expect(repeatedRequests).toEqual(["requested", "requested", "requested"]);
  }

  const resumed = faultController.waitFor((event) => (
    event.type === "resumed"
    && event.terminalId === terminalId
    && event.direction === "server-to-browser"
  ), { timeoutMs: DIAGNOSTICS_TIMEOUT });
  faultController.resume("server-to-browser", { terminalId });
  await resumed;
  pauseRule.dispose();

  const queuedLine = `[E2E:PRINT:${queuedId}:${queuedText}]`;
  await expectTerminalBuffer(page, terminalId, { contains: queuedLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "r-03-after-fallback",
  });
  const changed = await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "r-03-queued-output-pixels",
  });
  expect(changed.changedRatio).toBeGreaterThanOrEqual(0.002);

  const afterRepeated = await expectTerminalInteractive(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  expect(afterRepeated.renderer).not.toBe("webgl");
  expect(afterRepeated.rendererState.kind).toBe(afterRepeated.renderer);
  expect(afterRepeated.activeSocketCount).toBe(1);
  expect(afterRepeated.socket.activeCount).toBe(1);
  expect(afterRepeated.webglLoadCount).toBe(afterFallback.webglLoadCount);
  expect(afterRepeated.contextLossCount).toBe(afterFallback.contextLossCount);
  expect(afterRepeated.fallbackCount).toBe(afterFallback.fallbackCount);
  expect(afterRepeated.renderCount).toBeGreaterThan(afterFallback.renderCount);
  const afterRepeatedResources = await readRendererResources(pane);
  assertNoRendererResourceGrowth(beforeResources, afterFallbackResources, afterRepeatedResources);

  const echoId = marker(testInfo.testId, "CONTINUED-INPUT");
  const echoArm = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: TRANSCRIPT_TIMEOUT },
  );
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await echoArm;
  const echoText = marker(testInfo.testId, "INPUT-AFTER-LOSS");
  const echoPayload = server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: TRANSCRIPT_TIMEOUT },
  );
  await pane.sendInput(echoText, true);
  const echoEntry = await echoPayload;
  expect(echoEntry.bytes).toBe(echoText.length);
  const echoLine = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText).toString("base64")}]`;
  await expectTerminalBuffer(page, terminalId, { contains: echoLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalBuffer(page, terminalId, { contains: beforeLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });
  await expectTerminalBuffer(page, terminalId, { contains: queuedLine, occurrences: 1 }, { timeout: DIAGNOSTICS_TIMEOUT });

  const final = await expectTerminalInteractive(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.socket.activeCount).toBe(1);
  expect(final.acceptingInput).toBe(true);
  expect(final.renderer).not.toBe("webgl");
  expect(final.rendererState.kind).toBe(final.renderer);
  expect(final.webglLoadCount).toBe(afterFallback.webglLoadCount);
  expect(final.contextLossCount).toBe(afterFallback.contextLossCount);
  expect(final.fallbackCount).toBe(afterFallback.fallbackCount);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  await expectNoPendingRecovery(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });

  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: DIAGNOSTICS_TIMEOUT });
  expect(invariantReport.violations).toEqual([]);
  await assertMonotonicSequences(invariantReport.events);
  const events = await terminalEvents(page, terminalId);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  if (rendererReady.renderer === "webgl") {
    expect(events.filter((event) => event.type === "renderer-context-loss")).toHaveLength(1);
    expect(events.filter((event) => event.type === "renderer-fallback")).toHaveLength(1);
  }
  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || (entry.kind === "console" && /^error:/i.test(entry.message))
    || /unhandled(?:promise)?|uncaught/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors, "repeated renderer loss produced an unexpected browser error").toEqual([]);
});
