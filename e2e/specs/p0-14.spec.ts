import { test, expect } from "../fixtures/test.js";
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
  terminalEvents,
  terminalSnapshot,
  waitForTerminalEvent,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

test("@p0 P0-14 Font completes after initial layout", async ({ page, server }, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const browserViewportBefore = page.viewportSize();
  if (!browserViewportBefore) throw new Error("Playwright did not provide a browser viewport");

  await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.font.delay();
  });

  const mountEvent = page.evaluate(async () => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent("mount", { timeout: 15_000 });
  });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const terminal = workbench.terminal(terminalId);
  await terminal.expectVisible();

  const fallback = await expectTerminalSynchronized(page, terminalId, { timeout: 15_000 });
  expect(fallback.cols).toBeGreaterThan(0);
  expect(fallback.rows).toBeGreaterThan(0);
  expect(fallback.serverViewport).toBeDefined();
  expect(fallback.serverViewport?.cols).toBe(fallback.cols);
  expect(fallback.serverViewport?.rows).toBe(fallback.rows);

  const fallbackEvents = await terminalEvents(page, terminalId);
  expect(fallbackEvents.filter((event) => event.type === "font-load")).toHaveLength(0);
  const terminalViewport = terminal.xtermHost.locator(".xterm-screen");
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "p0-14-fallback-font-crop",
  });

  const fontLoadedPromise = waitForTerminalEvent(page, terminalId, "font-load", {
    timeout: 15_000,
    afterId: 0,
  });
  await page.evaluate(() => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.font.release();
  });
  const fontLoaded = await fontLoadedPromise;
  expect(fontLoaded.data.result).toBe("settled");

  const final = await page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const selected = snapshot.serverViewport;
      return snapshot.socketState === "connected"
        && snapshot.pendingParserWrites === 0
        && desired !== undefined
        && selected !== undefined
        && desired.cols === selected.cols
        && desired.rows === selected.rows;
    }, { timeout: 15_000 });
  }, terminalId);
  const converged = await expectTerminalConverged(page, terminalId, {
    cols: final.cols,
    rows: final.rows,
  }, { timeout: 15_000 });
  expect(converged.serverViewport?.cols).toBe(final.cols);
  expect(converged.serverViewport?.rows).toBe(final.rows);
  expect(converged.viewport.cols).toBe(final.cols);
  expect(converged.viewport.rows).toBe(final.rows);

  const browserViewportAfter = page.viewportSize();
  expect(browserViewportAfter).toEqual(browserViewportBefore);

  const printId = `WIDTH-FINAL-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const markerPrefix = `[E2E:PRINT:${printId}:`;
  const fillerLength = Math.max(1, final.cols - markerPrefix.length - 1);
  const widthText = "W".repeat(fillerLength);
  const widthMarker = `${markerPrefix}${widthText}]`;
  const beforePrint = await screenshotRegion(page, terminalViewport);

  await terminal.sendInput(`PRINT ${printId} ${widthText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === printId);
  await expectTerminalBuffer(page, terminalId, {
    contains: widthMarker,
    occurrences: 1,
  }, { timeout: 15_000 });
  const { after: afterPrint } = await expectKnownMarkerChanged(page, terminalViewport, beforePrint, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-14-final-font-marker-crop",
  });
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "p0-14-final-font-crop",
  });
  expect(afterPrint.width).toBe(beforePrint.width);
  expect(afterPrint.height).toBe(beforePrint.height);

  const sizeId = `WIDTH-SIZE-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  await terminal.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId);
  expect(size.cols).toBe(final.cols);
  expect(size.rows).toBe(final.rows);

  const echoId = `WIDTH-ECHO-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const inputMarker = `WIDTH-IN-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ));
  await terminal.sendInput(inputMarker, true);
  const payload = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
  ));
  expect(payload.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
  ))).toHaveLength(1);

  const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: 15_000 });
  expect(invariantReport.events.filter((event) => event.type === "font-load")).toHaveLength(1);
  expect(invariantReport.events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(invariantReport.events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(invariantReport.events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(invariantReport.snapshot.activeSocketCount).toBe(1);
  expect(invariantReport.snapshot.socketState).toBe("connected");
  expect(invariantReport.snapshot.acceptingInput).toBe(true);
  assertNoPendingSynchronization(invariantReport.snapshot);

  const finalSnapshot = await terminalSnapshot(page, terminalId);
  if (!finalSnapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  expect(finalSnapshot.cols).toBe(final.cols);
  expect(finalSnapshot.rows).toBe(final.rows);
  expect(finalSnapshot.serverViewport?.cols).toBe(final.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(final.rows);
  expect(finalSnapshot.xterm.text.replaceAll("\n", "")).toContain(widthMarker);
});
