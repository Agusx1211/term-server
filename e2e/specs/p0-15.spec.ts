import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import { expectConnectedTerminalInvariants, assertNoPendingSynchronization } from "../assertions/invariants.js";
import { assertMonotonicSequences, terminalEvents } from "../assertions/terminal-state.js";
import { expectTerminalNonBlank, expectTerminalPixelsChanged, screenshotRegion } from "../assertions/terminal-pixels.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";

const REPAINT_BYTES = 1_300_000;
const WAIT_TIMEOUT_MS = 30_000;
const READY_ID = "P015_BASELINE";
const REPAINT_ID = "P015_REPAINT";
const LIVE_ID = "P015_LIVE";
const LIVE_TEXT = "P015_LIVE_UPDATE";
const ECHO_ID = "P015_ECHO";
const ECHO_PAYLOAD = "P015_INPUT";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]\n`;
}
function compactText(value: string): string {
  return value.replace(/\r?\n/g, "");
}


function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length || 1;
  }
  return count;
}

async function waitForOutputEnd(
  page: Page,
  terminalId: string,
  expectedText: string,
  minimumRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expectedText: markerText, minimumRender, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.syncMode === undefined
      && (snapshot.syncTarget === undefined
        || snapshot.committedSequence === undefined
        || snapshot.committedSequence >= snapshot.syncTarget)
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderCount >= minimumRender
      && snapshot.xterm.text.replaceAll("\n", "").includes(markerText)
    ), { timeout });
  }, {
    id: terminalId,
    expectedText,
    minimumRender: minimumRenderCount,
    timeout: WAIT_TIMEOUT_MS,
  });
}

function outputBytesSince(
  baseline: E2ETerminalSnapshot,
  final: E2ETerminalSnapshot,
): number {
  if (baseline.committedSequence === undefined || final.committedSequence === undefined || final.receivedSequence === undefined) {
    throw new Error("terminal diagnostics did not expose committed and received sequences");
  }
  expect(final.receivedSequence).toBe(final.committedSequence);
  return final.committedSequence - baseline.committedSequence;
}

test("@p0 @smoke P0-15 Large full-screen repaint stays connected", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  await page.goto(baseURL);
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const paneSlot = page.locator('.pane-slot:not(.cached)[data-terminal-id]').first();
  await expect(paneSlot).toBeVisible();
  const terminalId = await paneSlot.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("new terminal did not expose a stable terminal ID");

  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  const connected = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  expect(connected.socketState).toBe("connected");
  expect(connected.activeSocketCount).toBe(1);
  expect(connected.acceptingInput).toBe(true);

  await pane.sendInput(`READY ${READY_ID}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === READY_ID,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const readyMarker = marker("READY", READY_ID);
  const ready = await waitForOutputEnd(
    page,
    terminalId,
    compactText(readyMarker),
    connected.renderCount,
  );
  expect(compactText(ready.xterm.text)).toContain(compactText(readyMarker));
  expect(ready.pendingParserWrites).toBe(0);
  expect(ready.renderBacklogBytes).toBe(0);

  const baselineEvents = await terminalEvents(page, terminalId);
  const baselineLastEventId = baselineEvents.at(-1)?.id ?? 0;
  const before = await screenshotRegion(page, pane.xtermHost);
  const repaintMarker = marker("REPAINT", REPAINT_ID, "FRAME");
  const liveMarker = marker("PRINT", LIVE_ID, LIVE_TEXT);
  const echoPayloadBase64 = Buffer.from(ECHO_PAYLOAD, "utf8").toString("base64");
  const echoReadyMarker = marker("ECHO_INPUT", ECHO_ID, "READY");
  const echoPayloadMarker = marker("ECHO_INPUT", ECHO_ID, echoPayloadBase64);
  const expectedWorkloadBytes = REPAINT_BYTES
    + Buffer.byteLength(liveMarker, "utf8")
    + Buffer.byteLength(echoReadyMarker, "utf8")
    + Buffer.byteLength(echoPayloadMarker, "utf8");

  // Keep delivery fast enough to create observable parser work, but never pause or
  // close the stream: a healthy large repaint must not be abandoned as a recovery.
  const throttle = faultController.throttle("server-to-browser", 16 * 1024 * 1024, { terminalId });
  const unexpectedConnectionEvents: string[] = [];
  const connectionObserver = faultController.onEvent((event) => {
    if (
      event.terminalId === terminalId
      && (
        event.type === "connection-open"
        || event.type === "connection-closed"
        || event.type === "connection-terminated"
      )
    ) {
      unexpectedConnectionEvents.push(event.type);
    }
  });
  try {
    await pane.sendInput(`REPAINT ${REPAINT_ID} ${REPAINT_BYTES}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "write" && entry.bytes === REPAINT_BYTES,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );

    // The smaller live update is sent while the repaint's frames are still being
    // parsed, preserving the production ordering boundary instead of waiting for
    // a synthetic idle period.
    await pane.sendInput(`PRINT ${LIVE_ID} ${LIVE_TEXT}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === LIVE_ID,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const live = await waitForOutputEnd(
      page,
      terminalId,
      compactText(liveMarker),
      ready.renderCount + 1,
    );
    expect(live.activeSocketCount).toBe(1);
    expect(compactText(live.xterm.text)).toContain(compactText(repaintMarker));
    expect(compactText(live.xterm.text)).toContain(compactText(liveMarker));

    await pane.sendInput(`ECHO_INPUT ${ECHO_ID}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === ECHO_ID && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await pane.sendInput(ECHO_PAYLOAD, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === ECHO_ID && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const final = await waitForOutputEnd(
      page,
      terminalId,
      compactText(echoPayloadMarker),
      live.renderCount + 1,
    );

    expect(final.socketState).toBe("connected");
    expect(final.activeSocketCount).toBe(1);
    expect(final.socketGeneration).toBe(ready.socketGeneration);
    expect(final.pendingParserWrites).toBe(0);
    expect(final.pendingParserBytes).toBe(0);
    expect(final.renderBacklogBytes).toBe(0);
    expect(final.renderBacklogFrames).toBe(0);
    expect(compactText(final.xterm.text)).toContain(compactText(repaintMarker));
    expect(compactText(final.xterm.text)).toContain(compactText(liveMarker));
    expect(compactText(final.xterm.text)).toContain(compactText(echoReadyMarker));
    expect(compactText(final.xterm.text)).toContain(compactText(echoPayloadMarker));
    const compactFinalText = compactText(final.xterm.text);
    expect(countOccurrences(compactFinalText, compactText(liveMarker))).toBe(1);
    expect(countOccurrences(compactFinalText, compactText(echoReadyMarker))).toBe(1);
    expect(countOccurrences(compactFinalText, compactText(echoPayloadMarker))).toBe(1);
    expect(outputBytesSince(ready, final)).toBe(expectedWorkloadBytes);

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "repaint" && entry.id === REPAINT_ID)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === LIVE_ID)).toHaveLength(1);
    const echoPayloadEntries = transcript.filter(
      (entry) => entry.event === "echo_input" && entry.id === ECHO_ID && entry.phase === "payload",
    );
    expect(echoPayloadEntries).toHaveLength(1);
    expect(echoPayloadEntries[0]?.payload_base64).toBe(echoPayloadBase64);

    const events = await terminalEvents(page, terminalId);
    const postEvents = events.filter((event) => event.id > baselineLastEventId);
    const backlogSnapshots = postEvents.filter((event) => (
      event.snapshot.pendingParserWrites > 0
      || event.snapshot.pendingParserBytes > 0
      || event.snapshot.renderBacklogBytes > 0
      || event.snapshot.renderBacklogFrames > 0
    ));
    expect(backlogSnapshots.length, "large repaint never exposed parser/render backlog").toBeGreaterThan(0);
    expect(postEvents.filter((event) => event.type === "socket-created")).toHaveLength(0);
    expect(postEvents.filter((event) => event.type === "sync")).toHaveLength(0);
    expect(postEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
    expect(postEvents.filter((event) => event.type === "state" && event.data.state === "recovering")).toHaveLength(0);
    await assertMonotonicSequences(events);


    const after = await screenshotRegion(page, pane.xtermHost);
    await expectTerminalPixelsChanged(before, after, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "p0-15-repaint-after",
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "p0-15-repaint-final",
    });

    const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(invariantReport.events.filter((event) => event.type === "error")).toHaveLength(0);
    assertNoPendingSynchronization(invariantReport.snapshot);
    expect(unexpectedConnectionEvents).toEqual([]);
  } finally {
    connectionObserver.dispose();
    throttle.dispose();
  }
});
