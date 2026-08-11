import { test, expect } from "../fixtures/test.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  terminalEvents,
  waitForFontSettledViewport,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

const FLOW_TIMEOUT_MS = 30_000;
const FLOW_HIGH_WATERMARK_BYTES = 100_000;
const FLOW_LOW_WATERMARK_BYTES = 5_000;
const BURST_BYTES = 512_000;

const isOutputFrame = (event: { readonly type: string; readonly direction?: string; readonly frame?: { readonly binaryKind?: number } }): boolean => (
  event.type === "frame"
  && event.direction === "server-to-browser"
  && event.frame?.binaryKind === 1
);

const isAcknowledgementFrame = (event: { readonly type: string; readonly direction?: string; readonly frame?: { readonly jsonType?: string } }): boolean => (
  event.type === "frame"
  && event.direction === "browser-to-server"
  && event.frame?.jsonType === "ack"
);
const terminalFramePayloadBytes = (frameBytes: number): number => {
  const webSocketHeaderBytes = frameBytes <= 127 ? 2 : frameBytes <= 65_539 ? 4 : 10;
  return frameBytes - webSocketHeaderBytes - 9;
};

test("@p0 @smoke P0-16 Flow control pauses and resumes correctly", async ({ page, server, faultController }, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountEvent = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent("mount", { timeout });
  }, { timeout: FLOW_TIMEOUT_MS });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const terminal = workbench.terminal(terminalId);
  await terminal.expectVisible();

  const token = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.retry}`;
  const burstId = `FLOW-BURST-${token}`;
  const printId = `FLOW-RESUMED-${token}`;
  const echoId = `FLOW-ECHO-${token}`;
  const inputMarker = `FLOW-IN-${token}`;

  const initial = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.flowControlled
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, timeout: FLOW_TIMEOUT_MS });
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);
  expect(initial.flowControlled).toBe(true);
  expect(initial.activeSocketCount).toBe(1);
  expect(initial.pendingParserWrites).toBe(0);
  expect(initial.renderBacklogBytes).toBe(0);
  expect(initial.receivedSequence).toBeDefined();
  expect(initial.committedSequence).toBe(initial.receivedSequence);
  expect(initial.flowAcknowledgedBytes).toBeGreaterThanOrEqual(0);
  expect(initial.flowPendingAcknowledgementBytes).toBeGreaterThanOrEqual(0);
  expect(initial.flowPendingAcknowledgementBytes).toBeLessThan(FLOW_LOW_WATERMARK_BYTES);
  expect(initial.flowAcknowledgedBytes + initial.flowPendingAcknowledgementBytes).toBeLessThanOrEqual(initial.committedSequence ?? 0);

  const terminalViewport = terminal.xtermHost.locator(".xterm-screen");
  await waitForFontSettledViewport(page, terminalId, { timeout: FLOW_TIMEOUT_MS });
  const beforeBurst = await screenshotRegion(page, terminalViewport);

  const pauseRule = faultController.pause("server-to-browser", { terminalId });
  const pauseEvent = await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.direction === "server-to-browser"
  ), { timeoutMs: FLOW_TIMEOUT_MS });
  const synchronizedBaseline = await page.evaluate(async ({ id, timeout, acknowledgementLimit }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.flowControlled
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.flowPendingAcknowledgementBytes < acknowledgementLimit
    ), { timeout });
  }, { id: terminalId, timeout: FLOW_TIMEOUT_MS, acknowledgementLimit: FLOW_LOW_WATERMARK_BYTES });
  expect(synchronizedBaseline.receivedSequence).toBeDefined();
  expect(synchronizedBaseline.committedSequence).toBe(synchronizedBaseline.receivedSequence);
  expect(synchronizedBaseline.flowAcknowledgedBytes).toBeGreaterThanOrEqual(0);
  expect(synchronizedBaseline.flowPendingAcknowledgementBytes).toBeGreaterThanOrEqual(0);
  expect(synchronizedBaseline.flowPendingAcknowledgementBytes).toBeLessThan(FLOW_LOW_WATERMARK_BYTES);

  let outputBytesBeforeResume = 0;
  let highWatermarkResolve: (() => void) | undefined;
  const highWatermarkReached = new Promise<void>((resolve) => {
    highWatermarkResolve = resolve;
  });
  const outputObserver = faultController.onEvent((event) => {
    if (!isOutputFrame(event)) return;
    // The proxy exposes raw websocket frame bytes. Subtracting a deliberately
    // conservative framing allowance keeps this lower-bound payload count
    // below the broker's actual unacknowledged byte count.
    outputBytesBeforeResume += Math.max(0, (event.bytes ?? 0) - 32);
    if (outputBytesBeforeResume > FLOW_HIGH_WATERMARK_BYTES) highWatermarkResolve?.();
  });

  await terminal.sendInput(`BURST ${burstId} ${BURST_BYTES} 80`, true);
  const burst = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "burst" && entry.id === burstId
  ), { timeoutMs: FLOW_TIMEOUT_MS });
  await highWatermarkReached;
  outputObserver.dispose();

  const burstSequence = Number(burst.sequence);
  expect(Number.isSafeInteger(burstSequence)).toBe(true);
  expect(outputBytesBeforeResume).toBeGreaterThan(FLOW_HIGH_WATERMARK_BYTES);

  // The fixture records a write only after the complete BURST write returns.
  // Reaching the high watermark must therefore stop the PTY reader before the
  // blocked writer can record completion.
  const pausedTranscript = await server.readTranscript(terminalId);
  const writesCompletedBeforeResume = pausedTranscript.filter((entry) => (
    entry.event === "write"
    && Number(entry.sequence) > burstSequence
    && entry.bytes === BURST_BYTES
  ));
  expect(writesCompletedBeforeResume).toHaveLength(0);

  const burstWrite = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "write"
    && Number(entry.sequence) > burstSequence
    && entry.bytes === BURST_BYTES
  ), { timeoutMs: FLOW_TIMEOUT_MS });

  const resumePromise = faultController.waitFor((event) => (
    event.type === "resumed"
    && event.terminalId === terminalId
    && event.direction === "server-to-browser"
  ), { timeoutMs: FLOW_TIMEOUT_MS });
  faultController.resume("server-to-browser", { terminalId });
  const resumeEvent = await resumePromise;
  pauseRule.dispose();

  await burstWrite;
  await terminal.sendInput(`PRINT ${printId} resumed`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === printId
  ), { timeoutMs: FLOW_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${printId}:resumed]`,
    occurrences: 1,
  }, { timeout: FLOW_TIMEOUT_MS });
  const printMarker = `[E2E:PRINT:${printId}:resumed]\n`;
  const expectedFlowBytes = BURST_BYTES + Buffer.byteLength(printMarker, "utf8");
  const flowSnapshot = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.flowControlled
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, timeout: FLOW_TIMEOUT_MS });
  expect(flowSnapshot.receivedSequence).toBeDefined();
  expect(flowSnapshot.committedSequence).toBe(flowSnapshot.receivedSequence);
  const flowReceivedDelta = (flowSnapshot.receivedSequence ?? 0) - (synchronizedBaseline.receivedSequence ?? 0);
  const flowCommittedDelta = (flowSnapshot.committedSequence ?? 0) - (synchronizedBaseline.committedSequence ?? 0);
  const flowAcknowledgedDelta = flowSnapshot.flowAcknowledgedBytes - synchronizedBaseline.flowAcknowledgedBytes;
  const flowPendingAcknowledgementDelta = flowSnapshot.flowPendingAcknowledgementBytes - synchronizedBaseline.flowPendingAcknowledgementBytes;
  expect(flowReceivedDelta).toBe(expectedFlowBytes);
  expect(flowCommittedDelta).toBe(expectedFlowBytes);
  expect(flowAcknowledgedDelta).toBeGreaterThanOrEqual(0);
  expect(flowPendingAcknowledgementDelta + flowAcknowledgedDelta).toBe(flowCommittedDelta);
  expect(flowSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(FLOW_LOW_WATERMARK_BYTES);

  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ), { timeoutMs: FLOW_TIMEOUT_MS });
  await terminal.sendInput(inputMarker, true);
  const echoPayload = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
  ), { timeoutMs: FLOW_TIMEOUT_MS });
  expect(echoPayload.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));

  const finalSnapshot = await page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
      && snapshot.receivedSequence !== undefined
      && snapshot.committedSequence === snapshot.receivedSequence
    ), { timeout });
  }, { id: terminalId, timeout: FLOW_TIMEOUT_MS });

  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.flowControlled).toBe(true);
  expect(finalSnapshot.flowAcknowledgedBytes).toBeGreaterThanOrEqual(0);
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeGreaterThanOrEqual(0);
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(FLOW_LOW_WATERMARK_BYTES);
  expect(finalSnapshot.receivedSequence).toBeDefined();
  expect(finalSnapshot.committedSequence).toBe(finalSnapshot.receivedSequence);
  expect(finalSnapshot.flowAcknowledgedBytes).toBeLessThanOrEqual(finalSnapshot.committedSequence ?? 0);
  const outstanding = (finalSnapshot.receivedSequence ?? 0) - finalSnapshot.flowAcknowledgedBytes;
  expect(outstanding).toBeGreaterThanOrEqual(0);
  expect(outstanding).toBeLessThan(FLOW_LOW_WATERMARK_BYTES);
  const finalCommittedDelta = (finalSnapshot.committedSequence ?? 0) - (synchronizedBaseline.committedSequence ?? 0);
  const finalAcknowledgedDelta = finalSnapshot.flowAcknowledgedBytes - synchronizedBaseline.flowAcknowledgedBytes;
  const finalPendingAcknowledgementDelta = finalSnapshot.flowPendingAcknowledgementBytes - synchronizedBaseline.flowPendingAcknowledgementBytes;
  expect(finalCommittedDelta).toBeGreaterThanOrEqual(0);
  expect(finalAcknowledgedDelta).toBeGreaterThanOrEqual(0);
  expect(finalAcknowledgedDelta).toBeLessThanOrEqual(finalCommittedDelta);
  expect(finalAcknowledgedDelta + finalPendingAcknowledgementDelta).toBe(finalCommittedDelta);

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  const parserCommits = events.filter((event) => event.type === "parser-commit");
  expect(parserCommits.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.snapshot.flowAcknowledgedBytes).toBeGreaterThanOrEqual(0);
    expect(event.snapshot.flowPendingAcknowledgementBytes).toBeGreaterThanOrEqual(0);
    if (event.snapshot.committedSequence !== undefined) {
      expect(event.snapshot.flowAcknowledgedBytes + event.snapshot.flowPendingAcknowledgementBytes).toBeLessThanOrEqual(event.snapshot.committedSequence);
    }
  }
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => (
    event.type === "state"
    && ["recovering", "disconnected"].includes(String(event.data.state))
  ))).toHaveLength(0);

  const networkEvents = faultController.events;
  const pauseIndex = networkEvents.indexOf(pauseEvent);
  const resumeIndex = networkEvents.indexOf(resumeEvent);
  expect(pauseIndex).toBeGreaterThanOrEqual(0);
  expect(resumeIndex).toBeGreaterThan(pauseIndex);
  const pausedEvents = networkEvents.slice(pauseIndex + 1, resumeIndex);
  const pausedAcknowledgements = pausedEvents.filter((event) => isAcknowledgementFrame(event));
  expect(pausedAcknowledgements).toHaveLength(0);

  const outputFrames = networkEvents.filter((event) => isOutputFrame(event));
  const outputFramesBeforeResume = networkEvents.slice(pauseIndex + 1, resumeIndex).filter((event) => isOutputFrame(event));
  const outputFramesAfterPause = networkEvents.slice(pauseIndex + 1).filter((event) => isOutputFrame(event));
  const baselineSequence = synchronizedBaseline.committedSequence ?? 0;
  const outputFramesSinceBaseline = outputFrames.filter((event) => (
    (event.frame?.sequence ?? -1) >= baselineSequence
    && (event.frame?.sequence ?? Number.POSITIVE_INFINITY) < (flowSnapshot.receivedSequence ?? 0)
  ));
  expect(outputFramesBeforeResume.length).toBeGreaterThan(0);
  expect(outputFramesAfterPause.length).toBeGreaterThan(0);
  expect(outputFramesSinceBaseline.length).toBeGreaterThan(0);
  const acknowledgementsAfterResume = networkEvents.slice(resumeIndex + 1).filter((event) => isAcknowledgementFrame(event));
  expect(acknowledgementsAfterResume.length).toBeGreaterThan(0);
  const firstAcknowledgementIndex = networkEvents.findIndex((event, index) => index > resumeIndex && isAcknowledgementFrame(event));
  expect(firstAcknowledgementIndex).toBeGreaterThan(resumeIndex);
  const outputAfterAcknowledgement = networkEvents.slice(firstAcknowledgementIndex + 1).filter((event) => isOutputFrame(event));
  expect(outputAfterAcknowledgement.length).toBeGreaterThan(0);
  expect(outputFrames.length).toBeGreaterThan(outputFramesBeforeResume.length);

  const expectedAcknowledgementCommitSequences: number[] = [];
  let nextOutputSequence = baselineSequence;
  let pendingAcknowledgementBytes = synchronizedBaseline.flowPendingAcknowledgementBytes;
  for (const outputFrame of outputFramesSinceBaseline) {
    const frameSequence = outputFrame.frame?.sequence;
    expect(frameSequence).toBeDefined();
    expect(outputFrame.frame?.fin).toBe(true);
    const payloadBytes = terminalFramePayloadBytes(outputFrame.bytes ?? 0);
    expect(payloadBytes).toBeGreaterThan(0);
    expect(frameSequence).toBe(nextOutputSequence);
    nextOutputSequence = frameSequence! + payloadBytes;
    pendingAcknowledgementBytes += payloadBytes;
    if (pendingAcknowledgementBytes >= FLOW_LOW_WATERMARK_BYTES) {
      expectedAcknowledgementCommitSequences.push(nextOutputSequence);
      pendingAcknowledgementBytes = 0;
    }
  }
  expect(nextOutputSequence).toBe(flowSnapshot.receivedSequence);
  expect(pendingAcknowledgementBytes).toBe(flowSnapshot.flowPendingAcknowledgementBytes);
  expect(acknowledgementsAfterResume).toHaveLength(expectedAcknowledgementCommitSequences.length);

  let retainedAcknowledgementCount = 0;
  for (const [index, acknowledgement] of acknowledgementsAfterResume.entries()) {
    const parserCommit = parserCommits.findLast((commit) => commit.timestamp <= acknowledgement.at);
    if (!parserCommit) continue;
    retainedAcknowledgementCount += 1;
    expect(parserCommit.data.sequence).toBeGreaterThanOrEqual(expectedAcknowledgementCommitSequences[index]!);
  }
  expect(retainedAcknowledgementCount).toBeGreaterThan(0);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);

  const { after: afterBurst } = await expectKnownMarkerChanged(page, terminalViewport, beforeBurst, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-16-flow-output-crop",
  });
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "p0-16-flow-final-crop",
  });
  expect(afterBurst.width).toBe(beforeBurst.width);
  expect(afterBurst.height).toBe(beforeBurst.height);
  await expectTerminalInvariants(page, terminalId, { timeout: FLOW_TIMEOUT_MS });
});
