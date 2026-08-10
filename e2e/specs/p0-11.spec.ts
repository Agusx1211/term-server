import type { Page } from "@playwright/test";
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
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

interface E2EWindow extends Window {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
}

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

const waitForViewportAfter = (
  page: Page,
  terminalId: string,
  eventId: number,
  timeout = 30_000,
): Promise<E2ETerminalEvent> => page.evaluate(async ({ id, after, wait }) => {
  const api = (window as E2EWindow).__TERM_SERVER_E2E__;
  if (!api) throw new Error("term-server E2E diagnostics are unavailable");
  return api.waitForEvent(
    id,
    (event) => event.type === "viewport" && event.id > after,
    { timeout: wait },
  );
}, { id: terminalId, after: eventId, wait: timeout });

const waitForConvergedTerminal = (
  page: Page,
  terminalId: string,
  timeout = 30_000,
): Promise<E2ETerminalSnapshot> => page.evaluate(async ({ id, wait }) => {
  const api = (window as E2EWindow).__TERM_SERVER_E2E__;
  if (!api) throw new Error("term-server E2E diagnostics are unavailable");
  return api.waitForTerminal(id, (snapshot) => {
    const server = snapshot.serverViewport;
    if (!server || snapshot.socketState !== "connected") return false;
    return snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.cols === server.cols
      && snapshot.rows === server.rows
      && snapshot.desiredViewport?.cols === server.cols
      && snapshot.desiredViewport?.rows === server.rows;
  }, { timeout: wait });
}, { id: terminalId, wait: timeout });

const countOccurrences = (value: string, needle: string): number => {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, needle.length);
  }
  return count;
};

test("@p0 @smoke P0-11 WebGL load changes dimensions safely", async ({ page, server }, testInfo) => {
  await page.goto("/");
  const webglAvailable = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  });
  testInfo.annotations.push({
    type: "webgl-capability",
    description: `webglAvailable=${webglAvailable}`,
  });
  if (!webglAvailable) {
    test.skip(true, "WebGL is unavailable in this browser configuration");
  }

  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountEvent = page.evaluate(async () => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout: 20_000 });
  });
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  }, { timeout: 30_000 });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as CreatedTerminal;
  expect(created.id).not.toBe("");

  // Arm the E2E renderer gate by terminal ID before the pane's effect can start
  // the dynamic addon import. The gate is released by its deterministic timer.
  await page.evaluate(({ id }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.renderer.delayWebGL(id, 10_000);
  }, { id: created.id });

  const mounted = await mountEvent;
  expect(mounted.terminalId).toBe(created.id);
  const terminal = workbench.terminal(created.id, created.name);
  await terminal.expectVisible();
  const terminalViewport = terminal.xtermHost.locator(".xterm-screen");
  await expect(terminalViewport).toBeVisible();

  const readyId = `P011_READY_${testInfo.workerIndex}_${testInfo.parallelIndex}_${testInfo.repeatEachIndex}`;
  const initialSizeId = `P011_INITIAL_SIZE_${testInfo.workerIndex}_${testInfo.parallelIndex}_${testInfo.repeatEachIndex}`;
  const finalSizeId = `P011_FINAL_SIZE_${testInfo.workerIndex}_${testInfo.parallelIndex}_${testInfo.repeatEachIndex}`;
  const widthId = `P011_WIDTH_MARK_${testInfo.workerIndex}_${testInfo.parallelIndex}_${testInfo.repeatEachIndex}`;
  const echoId = `P011_ECHO_${testInfo.workerIndex}_${testInfo.parallelIndex}_${testInfo.repeatEachIndex}`;
  const echoText = `P011_CONTINUED_INPUT_${testInfo.workerIndex}_${testInfo.parallelIndex}_${testInfo.repeatEachIndex}`;

  const initial = await page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderer !== "webgl"
    ), { timeout: 20_000 });
  }, created.id);
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);
  expect(initial.renderer).not.toBe("webgl");
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  expect(initial.serverViewport).toBeDefined();
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);

  await terminal.sendInput(`SIZE ${initialSizeId}`, true);
  const initialSize = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number }>(
    created.id,
    (entry) => entry.event === "size" && entry.id === initialSizeId,
  );
  expect(initialSize.rows).toBe(initial.rows);
  expect(initialSize.cols).toBe(initial.cols);

  await terminal.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(created.id, (entry) => entry.event === "ready" && entry.id === readyId);
  await expectTerminalBuffer(page, created.id, {
    contains: `[E2E:READY:${readyId}]`,
    occurrences: 1,
  });

  const rendererLoadPromise = terminal.waitForEvent("renderer-load", { timeout: 30_000 });
  const rendererLoaded = await rendererLoadPromise;
  expect(rendererLoaded.snapshot.renderer).toBe("webgl");
  expect(rendererLoaded.snapshot.webglLoadCount).toBe(1);

  const viewportMeasured = await waitForViewportAfter(page, created.id, rendererLoaded.id);
  expect(viewportMeasured.data.source).toBe("proposed");
  expect(viewportMeasured.snapshot.renderer).toBe("webgl");
  expect(viewportMeasured.data.cols).toBeGreaterThan(0);
  expect(viewportMeasured.data.rows).toBeGreaterThan(0);
  expect(viewportMeasured.data.pixelWidth).toBeGreaterThan(0);
  expect(viewportMeasured.data.pixelHeight).toBeGreaterThan(0);

  const converged = await waitForConvergedTerminal(page, created.id);
  expect(converged.renderer).toBe("webgl");
  expect(converged.serverViewport).toBeDefined();
  expect(converged.desiredViewport?.cols).toBe(converged.serverViewport?.cols);
  expect(converged.desiredViewport?.rows).toBe(converged.serverViewport?.rows);
  expect(converged.sentViewport?.cols).toBe(converged.serverViewport?.cols);
  expect(converged.sentViewport?.rows).toBe(converged.serverViewport?.rows);
  expect(converged.pixelWidth).toBeGreaterThan(0);
  expect(converged.pixelHeight).toBeGreaterThan(0);

  await terminal.sendInput(`SIZE ${finalSizeId}`, true);
  const finalSize = await server.waitForTranscript<{ event: string; id: string; rows: number; cols: number }>(
    created.id,
    (entry) => entry.event === "size" && entry.id === finalSizeId,
  );
  expect(finalSize.rows).toBe(converged.rows);
  expect(finalSize.cols).toBe(converged.cols);

  const beforeWidthMarker = await screenshotRegion(page, terminalViewport);
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "p0-11-before-width-marker-crop",
  });

  const widthText = `WIDTH-SENSITIVE-${widthId}-${"W".repeat(Math.max(16, converged.cols + 8))}`;
  const fullWidthMarker = `[E2E:PRINT:${widthId}:${widthText}]`;
  await terminal.sendInput(`PRINT ${widthId} ${widthText}`, true);
  const printEntry = await server.waitForTranscript<{ event: string; id: string; text: string }>(
    created.id,
    (entry) => entry.event === "print" && entry.id === widthId,
  );
  expect(printEntry.text).toBe(widthText);
  await expectTerminalBuffer(page, created.id, {
    contains: `[E2E:PRINT:${widthId}:`,
    occurrences: 1,
  });
  const markerSnapshot = await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id);
  }, created.id);
  if (!markerSnapshot) throw new Error(`No diagnostics snapshot for terminal ${created.id}`);
  const normalizedText = markerSnapshot.xterm.text.replaceAll("\n", "");
  expect(countOccurrences(normalizedText, fullWidthMarker)).toBe(1);

  const { after: afterWidthMarker } = await expectKnownMarkerChanged(page, terminalViewport, beforeWidthMarker, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-11-width-marker-crop",
  });
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "p0-11-after-width-marker-crop",
  });
  expect(afterWidthMarker.width).toBe(beforeWidthMarker.width);
  expect(afterWidthMarker.height).toBe(beforeWidthMarker.height);

  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(created.id, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ));
  await terminal.sendInput(echoText, true);
  const echoPayload = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    created.id,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
  );
  expect(echoPayload.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));

  const transcript = await server.readTranscript(created.id);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === widthId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

  const finalSnapshot = await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id);
  }, created.id);
  if (!finalSnapshot) throw new Error(`No diagnostics snapshot for terminal ${created.id}`);
  expect(finalSnapshot.renderer).toBe("webgl");
  expect(finalSnapshot.cols).toBe(converged.cols);
  expect(finalSnapshot.rows).toBe(converged.rows);
  expect(finalSnapshot.serverViewport?.cols).toBe(converged.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(converged.rows);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);

  const events = await terminalEvents(page, created.id);
  expect(events.filter((event) => event.type === "renderer-load")).toHaveLength(1);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => (
    event.type === "state" && ["disconnected", "recovering"].includes(String(event.data.state))
  ))).toHaveLength(0);
  const viewportEventsAfterRenderer = events.filter((event) => event.type === "viewport" && event.id > rendererLoaded.id);
  expect(viewportEventsAfterRenderer.length).toBeGreaterThan(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);

  const invariantReport = await expectConnectedTerminalInvariants(page, created.id, { timeout: 15_000 });
  expect(invariantReport.violations).toEqual([]);
});
