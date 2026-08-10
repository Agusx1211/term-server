import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import { expectKnownMarkerChanged, expectTerminalNonBlank, screenshotRegion } from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { E2ETerminalDiagnosticsApi, E2ETerminalSnapshot } from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_BROWSER_VIEWPORT = { width: 1280, height: 720 } as const;
const FINAL_BROWSER_VIEWPORT = { width: 1120, height: 620 } as const;
const RESIZE_STEPS = [
  { width: 1180, height: 680 },
  { width: 1040, height: 640 },
  { width: 1220, height: 700 },
  { width: 1080, height: 600 },
  FINAL_BROWSER_VIEWPORT,
] as const;
const BURST_BYTES = 240_000;
const BURST_LINE_WIDTH = 120;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length || 1;
  }
  return count;
}

async function waitForFinalGeometry(
  page: Page,
  terminalId: string,
  initial: E2ETerminalSnapshot,
  startedAt: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, initialCols, initialRows, startedAt, finalWidth, finalHeight, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const host = [...document.querySelectorAll<HTMLElement>(".xterm-host")]
        .find((candidate) => candidate.closest("[data-terminal-id]")?.getAttribute("data-terminal-id") === id);
      const desired = snapshot.desiredViewport;
      if (!host || !desired || window.innerWidth !== finalWidth || window.innerHeight !== finalHeight) return false;
      const rect = host.getBoundingClientRect();
      const layoutMatches = Math.abs(desired.pixelWidth - rect.width) <= 64
        && Math.abs(desired.pixelHeight - rect.height) <= 64;
      return snapshot.updatedAt > startedAt
        && (desired.cols !== initialCols || desired.rows !== initialRows)
        && layoutMatches
        && snapshot.socketState === "connected"
        && snapshot.sentViewport?.cols === desired.cols
        && snapshot.sentViewport?.rows === desired.rows
        && snapshot.serverViewport?.cols === desired.cols
        && snapshot.serverViewport?.rows === desired.rows
        && snapshot.cols === desired.cols
        && snapshot.rows === desired.rows
        && snapshot.pendingParserWrites === 0
        && snapshot.xterm.text.split("\n").every((line) => line.length <= snapshot.cols);
    }, { timeout });
  }, {
    id: terminalId,
    initialCols: initial.cols,
    initialRows: initial.rows,
    startedAt,
    finalWidth: FINAL_BROWSER_VIEWPORT.width,
    finalHeight: FINAL_BROWSER_VIEWPORT.height,
    timeout: WAIT_TIMEOUT_MS,
  });
}

test("@p0 @smoke P0-04 Rapid resize storm converges", async ({ page, server, faultController }, testInfo) => {
  await page.setViewportSize(INITIAL_BROWSER_VIEWPORT);
  await page.goto("/");
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const mountEvent = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();

  const token = `P004-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-${Date.now()}`;
  const readyId = `${token}-READY`;
  const headId = `${token}-HEAD`;
  const burstId = `${token}-BURST`;
  const tailId = `${token}-TAIL`;
  const finalId = `${token}-FINAL`;
  const sizeId = `${token}-SIZE`;
  const echoId = `${token}-ECHO`;
  const inputText = `${token}-INPUT`;

  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${headId} STORM-HEAD`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === headId, { timeoutMs: WAIT_TIMEOUT_MS });

  await pane.sendInput(`BURST ${burstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`, true);
  const burst = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "burst" && entry.id === burstId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(burst.bytes).toBe(BURST_BYTES);
  expect(burst.line_width).toBe(BURST_LINE_WIDTH);

  await pane.sendInput(`PRINT ${tailId} STORM-TAIL`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === tailId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${headId}:STORM-HEAD]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${tailId}:STORM-TAIL]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const beforeStorm = await server.readTranscript(terminalId);
  const stormSequenceFloor = beforeStorm.reduce((floor, entry) => {
    const sequence = typeof entry.sequence === "number" ? entry.sequence : 0;
    return Math.max(floor, sequence);
  }, 0);
  const resizeFrames: number[] = [];
  const resizeListener = faultController.onEvent((event) => {
    if (event.type === "frame"
      && event.terminalId === terminalId
      && event.direction === "browser-to-server"
      && event.frame?.jsonType === "resize") {
      resizeFrames.push(event.at);
    }
  });
  const stormStartedAt = Date.now();
  let finalSnapshot: E2ETerminalSnapshot | undefined;
  try {
    // These calls intentionally have no settle waits between them; the production 120 ms scheduler coalesces the storm.
    for (const viewport of RESIZE_STEPS) await workbench.setViewport(viewport.width, viewport.height);
    finalSnapshot = await waitForFinalGeometry(page, terminalId, initial, stormStartedAt);
  } finally {
    resizeListener.dispose();
  }
  if (!finalSnapshot) throw new Error(`No final diagnostics snapshot for terminal ${terminalId}`);
  expect(await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual(FINAL_BROWSER_VIEWPORT);
  expect(resizeFrames.length, "resize requests reaching the server must stay bounded by the storm sequence").toBeGreaterThan(0);
  expect(resizeFrames.length, "resize requests reaching the server must stay bounded by the storm sequence").toBeLessThanOrEqual(RESIZE_STEPS.length);

  const finalCols = finalSnapshot.cols;
  const finalRows = finalSnapshot.rows;
  expect(finalSnapshot.desiredViewport?.cols).toBe(finalCols);
  expect(finalSnapshot.desiredViewport?.rows).toBe(finalRows);
  expect(finalSnapshot.sentViewport?.cols).toBe(finalCols);
  expect(finalSnapshot.sentViewport?.rows).toBe(finalRows);
  expect(finalSnapshot.serverViewport?.cols).toBe(finalCols);
  expect(finalSnapshot.serverViewport?.rows).toBe(finalRows);
  const compactFinalText = finalSnapshot.xterm.text.replaceAll("\n", "");
  expect(compactFinalText).toContain(`[E2E:PRINT:${headId}:STORM-HEAD]`);
  expect(compactFinalText).toContain(`[E2E:PRINT:${tailId}:STORM-TAIL]`);
  expect(countOccurrences(compactFinalText, `[E2E:PRINT:${headId}:STORM-HEAD]`)).toBe(1);
  expect(countOccurrences(compactFinalText, `[E2E:PRINT:${tailId}:STORM-TAIL]`)).toBe(1);
  expect(finalSnapshot.xterm.text.split("\n").every((line) => line.length <= finalCols)).toBe(true);

  await pane.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "size" && entry.id === sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(size.cols).toBe(finalCols);
  expect(size.rows).toBe(finalRows);

  const afterSize = await server.readTranscript(terminalId);
  const stormWinches = afterSize.filter((entry) => (
    entry.event === "sigwinch"
    && typeof entry.sequence === "number"
    && entry.sequence > stormSequenceFloor
  ));
  expect(stormWinches.length, "PTY resize notifications must remain bounded by the browser storm").toBeLessThanOrEqual(RESIZE_STEPS.length);
  for (const winch of stormWinches) {
    expect(winch.cols).toEqual(expect.any(Number));
    expect(winch.rows).toEqual(expect.any(Number));
  }

  const beforeFinalMarker = await screenshotRegion(page, pane.xtermHost);
  await pane.sendInput(`PRINT ${finalId} STORM-FINAL`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === finalId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${finalId}:STORM-FINAL]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectKnownMarkerChanged(page, pane.xtermHost, beforeFinalMarker, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-04-final-marker-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "p0-04-final-terminal-crop",
  });

  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  const payload = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(payload.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputText, "utf8").toString("base64")}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "burst" && entry.id === burstId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && [headId, tailId, finalId].includes(String(entry.id)))).toHaveLength(3);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "write" && entry.bytes === BURST_BYTES)).toHaveLength(1);

  const events = await terminalEvents(page, terminalId);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  await assertMonotonicSequences(events);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);

  const settled = await page.evaluate(async ({ id, expectedCols, expectedRows, finalMarker, echoMarker, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const compactText = snapshot.xterm.text.replaceAll("\n", "");
      return snapshot.cols === expectedCols
        && snapshot.rows === expectedRows
        && snapshot.serverViewport?.cols === expectedCols
        && snapshot.serverViewport?.rows === expectedRows
        && snapshot.activeSocketCount === 1
        && snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && compactText.includes(finalMarker)
        && compactText.includes(echoMarker);
    }, { timeout });
  }, {
    id: terminalId,
    expectedCols: finalCols,
    expectedRows: finalRows,
    finalMarker: `[E2E:PRINT:${finalId}:STORM-FINAL]`,
    echoMarker: `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputText, "utf8").toString("base64")}]`,
    timeout: WAIT_TIMEOUT_MS,
  });
  expect(settled.cols).toBe(finalCols);
  expect(settled.rows).toBe(finalRows);
  expect(settled.serverViewport?.cols).toBe(finalCols);
  expect(settled.serverViewport?.rows).toBe(finalRows);
  expect(settled.activeSocketCount).toBe(1);
  expect(settled.socketState).toBe("connected");
  expect(settled.acceptingInput).toBe(true);
  expect(settled.pendingParserWrites).toBe(0);
  expect(settled.pendingParserBytes).toBe(0);
  expect(settled.renderBacklogBytes).toBe(0);
  expect(settled.renderCount).toBeGreaterThan(0);
  expect(settled.xterm.text).toContain(`[E2E:PRINT:${finalId}:STORM-FINAL]`);
  expect(settled.xterm.text).toContain(`[E2E:ECHO_INPUT:${echoId}:${Buffer.from(inputText, "utf8").toString("base64")}]`);
});
