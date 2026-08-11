import { test, expect } from "../fixtures/test.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertNoPendingSynchronization,
  expectTerminalInvariants,
} from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
} from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

const WAIT_TIMEOUT_MS = 15_000;
const ACK_BURST_BYTES = TERMINAL_ACK_BYTES + 1_024;
const ACK_BURST_LINE_WIDTH = 80;
const REGRESSING_STATES: Record<string, true> = {
  connecting: true,
  disconnected: true,
  recovering: true,
  closed: true,
};

function diagnosticGeneration(event: E2ETerminalEvent): number | undefined {
  const generation = event.data.generation;
  return typeof generation === "number" ? generation : undefined;
}

test("@p0 @smoke P0-19 Stale socket cannot disturb replacement socket", async ({
  page,
  server,
  faultController,
}, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountEvent = page.evaluate(async () => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout: 15_000 });
  });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const terminal = workbench.terminal(terminalId);
  await terminal.expectVisible();
  const terminalViewport = terminal.xtermHost.locator(".xterm-screen");
  await expect(terminalViewport).toBeVisible();

  const token = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const readyId = `P019-READY-${token}`;
  const queuedId = `P019-A-QUEUED-${token}`;
  const outputId = `P019-B-OUTPUT-${token}`;
  const echoId = `P019-B-ECHO-${token}`;
  const inputMarker = `P019-CONTINUED-${token}`;
  const ackBurstId = `P019-B-ACK-BURST-${token}`;

  const connectedA = await page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
    ), { timeout: 15_000 });
  }, terminalId);
  expect(connectedA.socketState).toBe("connected");
  expect(connectedA.activeSocketCount).toBe(1);

  await terminal.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "ready" && entry.id === readyId
  ));

  const aGeneration = connectedA.socketGeneration;
  expect(aGeneration).toBeGreaterThan(0);
  const aMatcher = { terminalId, generation: aGeneration };

  // Hold both directions of A. The fixture output and A's close handshake are
  // queued in the real proxy while the diagnostics close event starts B.
  const holdAFromServer = faultController.pause("server-to-browser", aMatcher);
  const serverPaused = await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.generation === aGeneration
    && event.direction === "server-to-browser"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const pauseEventIndex = faultController.events.indexOf(serverPaused);
  expect(pauseEventIndex).toBeGreaterThanOrEqual(0);

  await terminal.sendInput(`PRINT ${queuedId} queued-before-replacement`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === queuedId
  ));
  const queuedOutput = await faultController.waitFor((event) => (
    faultController.events.indexOf(event) > pauseEventIndex
    && event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === aGeneration
    && event.direction === "server-to-browser"
    && event.frame?.binaryKind === 1
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(queuedOutput.frame?.binaryKind).toBe(1);

  const holdAToServer = faultController.pause("browser-to-server", aMatcher);
  const browserPaused = await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.generation === aGeneration
    && event.direction === "browser-to-server"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(faultController.events.indexOf(browserPaused)).toBeGreaterThanOrEqual(pauseEventIndex);

  await page.evaluate(({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.close(id, { generation, abrupt: true, reason: "P019 delayed generation A close" });
  }, { id: terminalId, generation: aGeneration });

  const replacementGeneration = aGeneration + 1;
  const replacementCreated = await page.evaluate(async ({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => snapshot.socketGeneration === generation, {
      timeout: 15_000,
    });
  }, { id: terminalId, generation: replacementGeneration });
  expect(replacementCreated.socketGeneration).toBe(replacementGeneration);

  const connectedB = await page.evaluate(async ({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.activeSocketCount === 1
      && snapshot.pendingParserWrites === 0
    ), { timeout: 15_000 });
  }, { id: terminalId, generation: replacementGeneration });
  expect(connectedB.socketGeneration).toBe(replacementGeneration);
  expect(connectedB.socketState).toBe("connected");
  expect(connectedB.acceptingInput).toBe(true);

  const replacementOpen = await faultController.waitFor((event) => (
    event.type === "connection-open"
    && event.terminalId === terminalId
    && event.generation === replacementGeneration
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const replacementOpenIndex = faultController.events.indexOf(replacementOpen);
  expect(replacementOpenIndex).toBeGreaterThanOrEqual(0);

  // Release A only after B is connected. Its close frame and queued output
  // therefore arrive after B's connection-open barrier.
  faultController.resume("browser-to-server", aMatcher);
  const releasedToServer = await faultController.waitFor((event) => (
    event.type === "resumed"
    && event.terminalId === terminalId
    && event.generation === aGeneration
    && event.direction === "browser-to-server"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const releasedToServerIndex = faultController.events.indexOf(releasedToServer);
  expect(releasedToServerIndex).toBeGreaterThan(replacementOpenIndex);

  faultController.resume("server-to-browser", aMatcher);
  const releasedFromServer = await faultController.waitFor((event) => (
    event.type === "resumed"
    && event.terminalId === terminalId
    && event.generation === aGeneration
    && event.direction === "server-to-browser"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const releasedFromServerIndex = faultController.events.indexOf(releasedFromServer);
  expect(releasedFromServerIndex).toBeGreaterThan(replacementOpenIndex);
  holdAFromServer.dispose();
  holdAToServer.dispose();

  // Exercise the explicit stale-event seam as well as the queued proxy event.
  // A deliberately different size makes a stale size message observable if
  // any old listener mutates the replacement pane.
  const staleSize = {
    epoch: connectedB.gridEpoch ?? 0,
    cols: connectedB.cols + 7,
    rows: connectedB.rows + 3,
    focused: false,
    controller: true,
    responder: true,
  };
  await page.evaluate(({ id, generation, data }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.deliverStaleEvent(id, {
      generation,
      type: "message",
      data: JSON.stringify(data),
    });
    api.controls.socket.deliverStaleEvent(id, {
      generation,
      type: "close",
      code: 4001,
      reason: "P019 stale generation A close after B",
    });
  }, { id: terminalId, generation: aGeneration, data: staleSize });

  const eventsAfterStale = await terminalEvents(page, terminalId);
  const replacementDiagnosticOpen = eventsAfterStale.findLast((event) => (
    event.type === "socket-open" && diagnosticGeneration(event) === replacementGeneration
  ));
  if (!replacementDiagnosticOpen) throw new Error("replacement socket did not record a diagnostic open event");
  const staleEvents = eventsAfterStale.filter((event) => (
    event.type === "socket-stale" && diagnosticGeneration(event) === aGeneration
  ));
  expect(staleEvents.length).toBeGreaterThan(0);
  expect(staleEvents.some((event) => event.id > replacementDiagnosticOpen.id)).toBe(true);

  const stableAfterStale = await page.evaluate(async ({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && snapshot.socketState === "connected"
      && snapshot.activeSocketCount === 1
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
    ), { timeout: 15_000 });
  }, { id: terminalId, generation: replacementGeneration });
  expect(stableAfterStale.cols).toBe(connectedB.cols);
  expect(stableAfterStale.rows).toBe(connectedB.rows);
  expect(stableAfterStale.serverViewport?.cols).toBe(connectedB.serverViewport?.cols);
  expect(stableAfterStale.serverViewport?.rows).toBe(connectedB.serverViewport?.rows);

  const beforeOutput = await screenshotRegion(page, terminalViewport);
  await terminal.sendInput(`PRINT ${outputId} replacement-remains-live`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === outputId
  ));
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${outputId}:replacement-remains-live]`,
    occurrences: 1,
  });
  // The replacement marker is a single sparse line over the full terminal
  // crop; require a positive compositor change without demanding dense output.
  await expectKnownMarkerChanged(page, terminalViewport, beforeOutput, {
    minimumChangedRatio: 0.0001,
    testInfo,
    artifactName: "p0-19-replacement-output-crop",
  });
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "p0-19-replacement-terminal-crop",
  });

  // Ordinary replacement traffic is below the production ACK batch size.
  // Cross that threshold with a bounded fixture burst and observe the ACK on
  // generation B rather than treating flowControlled=true as an ACK promise.
  const ackFrame = faultController.waitFor((event) => (
    faultController.events.indexOf(event) > replacementOpenIndex
    && event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === replacementGeneration
    && event.direction === "browser-to-server"
    && event.frame?.jsonType === "ack"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await terminal.sendInput(`BURST ${ackBurstId} ${ACK_BURST_BYTES} ${ACK_BURST_LINE_WIDTH}`, true);
  const ackBurst = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "burst"
    && entry.id === ackBurstId
    && entry.bytes === ACK_BURST_BYTES
    && entry.line_width === ACK_BURST_LINE_WIDTH
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(ackBurst.bytes).toBe(ACK_BURST_BYTES);
  await page.evaluate(async ({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout: 15_000 });
  }, { id: terminalId, generation: replacementGeneration });
  const replacementAck = await ackFrame;
  expect(replacementAck.generation).toBe(replacementGeneration);
  expect(replacementAck.frame?.jsonType).toBe("ack");

  const inputFrame = faultController.waitFor((event) => (
    faultController.events.indexOf(event) > replacementOpenIndex
    && event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === replacementGeneration
    && event.direction === "browser-to-server"
    && event.frame?.opcode === 2
    && event.frame.binaryKind === "E".charCodeAt(0)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ));
  await terminal.sendInput(inputMarker, true);
  const payload = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
  ));
  await inputFrame;
  expect(payload.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));
  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
  ))).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${echoId}`,
    occurrences: 1,
  });
  await page.evaluate(async ({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(id, (snapshot) => (
      snapshot.socketGeneration === generation
      && snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.renderBacklogBytes === 0
    ), { timeout: 15_000 });
  }, { id: terminalId, generation: replacementGeneration });

  const finalSnapshot = await terminalSnapshot(page, terminalId);
  if (!finalSnapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  expect(finalSnapshot.socketGeneration).toBe(replacementGeneration);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.cols).toBe(connectedB.cols);
  expect(finalSnapshot.rows).toBe(connectedB.rows);
  expect(finalSnapshot.serverViewport?.cols).toBe(connectedB.serverViewport?.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(connectedB.serverViewport?.rows);
  expect(finalSnapshot.sentViewport?.source).toBe("sent");
  expect(finalSnapshot.urlViewport?.source).toBe("url");
  expect(finalSnapshot.sentViewport?.cols).toBe(finalSnapshot.cols);
  expect(finalSnapshot.sentViewport?.rows).toBe(finalSnapshot.rows);
  expect(finalSnapshot.xterm.text).not.toContain(`[E2E:PRINT:${queuedId}:queued-before-replacement]`);
  assertNoPendingSynchronization(finalSnapshot);

  const finalEvents = await terminalEvents(page, terminalId);
  const socketCreated = finalEvents.filter((event) => event.type === "socket-created");
  expect(socketCreated).toHaveLength(2);
  expect(socketCreated.map(diagnosticGeneration)).toEqual([aGeneration, replacementGeneration]);
  const postReplacementEvents = finalEvents.filter((event) => event.id > replacementDiagnosticOpen.id);
  expect(postReplacementEvents.filter((event) => event.type === "socket-created")).toHaveLength(0);
  expect(postReplacementEvents.filter((event) => (
    event.type === "state" && REGRESSING_STATES[String(event.data.state)] === true
  ))).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale" && diagnosticGeneration(event) === aGeneration).length).toBeGreaterThan(0);
  await assertMonotonicSequences(finalEvents);

  const postReplacementFrames = faultController.events.slice(replacementOpenIndex + 1).filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && (
      event.frame?.jsonType === "resize"
      || event.frame?.jsonType === "ack"
      || event.frame?.opcode === 2
    )
  ));
  for (const event of postReplacementFrames) expect(event.generation).toBe(replacementGeneration);
  expect(postReplacementFrames.some((event) => event.frame?.opcode === 2)).toBe(true);
  expect(finalSnapshot.flowControlled).toBe(true);
  expect(finalSnapshot.flowAcknowledgedBytes).toBeGreaterThan(0);
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(postReplacementFrames.some((event) => event.frame?.jsonType === "ack")).toBe(true);

  const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  expect(invariantReport.snapshot.socketState).toBe("connected");
  expect(invariantReport.snapshot.socketGeneration).toBe(replacementGeneration);
  expect(invariantReport.snapshot.activeSocketCount).toBe(1);
  expect(invariantReport.snapshot.acceptingInput).toBe(true);
});
