import { test, expect } from "../fixtures/test.js";
import type { NetworkFaultEvent } from "../fixtures/network-faults.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalConnected,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalBuffer,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 15_000;
type ViewportField = "desiredViewport" | "sentViewport" | "serverViewport";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

function compactModel(text: string): string {
  return text.replace(/\r?\n/g, "");
}

function occurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

async function waitForViewport(
  page: Parameters<typeof terminalSnapshot>[0],
  terminalId: string,
  field: ViewportField,
  expected: E2EViewport,
  includePixels = true,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, field, expected, includePixels, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot[field];
      if (!viewport || viewport.cols !== expected.cols || viewport.rows !== expected.rows) return false;
      return !includePixels
        || viewport.pixelWidth === expected.pixelWidth && viewport.pixelHeight === expected.pixelHeight;
    }, { timeout });
  }, { id: terminalId, field, expected, includePixels, timeout: WAIT_TIMEOUT_MS });
}

function frameKey(event: NetworkFaultEvent): string {
  const frame = event.frame;
  return [
    event.connectionId ?? "",
    event.generation ?? "",
    frame?.opcode ?? "",
    frame?.occurrence ?? "",
    frame?.bytes ?? "",
  ].join(":");
}

function browserFrame(event: NetworkFaultEvent, terminalId: string): boolean {
  return event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame !== undefined;
}

test("I-09 Input during resize @nightly @input @resize @ordering @pr", async ({ page, server, faultController }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/");
  await page.setViewportSize({ width: 1200, height: 700 });
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const region = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(region).toBeVisible();
  const terminalId = await region.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("new terminal did not expose a terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const terminalScreen = pane.xtermHost.locator(".xterm-screen");
  await expect(terminalScreen).toBeVisible();
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await pane.focus();

  await pane.sendInput("READY I09", true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "READY"
    && entry.command_base64 === commandBytes("READY I09")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === "I09", {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await waitForTerminalBuffer(page, terminalId, { contains: marker("READY", "I09"), occurrences: 1 }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const initial = await terminalSnapshot(page, terminalId);
  if (!initial) throw new Error("terminal diagnostics snapshot disappeared before resize");
  const geometryA = initial.proposedViewport ?? initial.desiredViewport ?? initial.serverViewport;
  if (!geometryA || geometryA.cols <= 0 || geometryA.rows <= 0) {
    throw new Error("terminal did not expose a positive initial proposed viewport");
  }
  const initialWinch = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "sigwinch"
    && entry.source === "signal"
    && entry.rows === geometryA.rows
    && entry.cols === geometryA.cols
    && entry.pixel_width === geometryA.pixelWidth
    && entry.pixel_height === geometryA.pixelHeight
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(initialWinch.cols).toBe(geometryA.cols);
  expect(initialWinch.rows).toBe(geometryA.rows);
  expect(initialWinch.pixel_width).toBe(geometryA.pixelWidth);
  expect(initialWinch.pixel_height).toBe(geometryA.pixelHeight);

  const baselineText = "BASELINE_OUTPUT_I09";
  const baselineCommand = `PRINT I09_A ${baselineText}`;
  const beforeBaseline = await screenshotRegion(page, terminalScreen);
  await pane.sendInput(baselineCommand, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "PRINT"
    && entry.command_base64 === commandBytes(baselineCommand)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === "I09_A" && entry.text === baselineText
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await waitForTerminalBuffer(page, terminalId, {
    contains: marker("PRINT", "I09_A", baselineText),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  const afterBaseline = await screenshotRegion(page, terminalScreen);
  await expectTerminalPixelsChanged(beforeBaseline, afterBaseline, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "i-09-baseline-crop",
  });

  const generation = initial.socketGeneration;
  const priorFrames = faultController.events.filter((event) => browserFrame(event, terminalId));
  const priorResizeOccurrences = priorFrames
    .filter((event) => event.frame?.jsonType === "resize")
    .map((event) => event.frame?.occurrence ?? 0);
  const highestPriorResizeOccurrence = Math.max(0, ...priorResizeOccurrences);

  const pause = faultController.pause("browser-to-server", { terminalId });
  await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  const desiredBPromise = page.evaluate(async ({ id, rows: oldRows, cols: oldCols, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const viewport = snapshot.desiredViewport;
      return viewport !== undefined
        && viewport.cols > 0
        && viewport.rows > 0
        && (viewport.cols !== oldCols || viewport.rows !== oldRows);
    }, { timeout });
  }, { id: terminalId, rows: geometryA.rows, cols: geometryA.cols, timeout: WAIT_TIMEOUT_MS });
  const resizeFramePromise = faultController.waitFor((event) => (
    browserFrame(event, terminalId)
    && event.generation === generation
    && event.frame?.jsonType === "resize"
    && (event.frame.occurrence ?? 0) > highestPriorResizeOccurrence
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  await workbench.setViewport(860, 540);
  const desiredB = await desiredBPromise;
  const geometryB = desiredB.desiredViewport;
  if (!geometryB || geometryB.cols <= 0 || geometryB.rows <= 0) {
    throw new Error("terminal did not expose a positive desired viewport after resize");
  }
  expect(geometryB.cols === geometryA.cols && geometryB.rows === geometryA.rows).toBe(false);

  const sentB = await waitForViewport(page, terminalId, "sentViewport", geometryB, true);
  expect(sentB.sentViewport?.cols).toBe(geometryB.cols);
  expect(sentB.sentViewport?.rows).toBe(geometryB.rows);
  const resizeFrame = await resizeFramePromise;
  expect(resizeFrame.frame?.jsonType).toBe("resize");

  const beforeInputFrames = new Set(faultController.events.filter((event) => browserFrame(event, terminalId)).map(frameKey));
  const bPayload = "I09_B_PAYLOAD";
  const bPayloadBase64 = Buffer.from(bPayload, "utf8").toString("base64");
  const inputFramePromise = faultController.waitFor((event) => (
    browserFrame(event, terminalId)
    && event.generation === generation
    && event.frame?.opcode === 2
    && event.at >= resizeFrame.at
    && !beforeInputFrames.has(frameKey(event))
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const bCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "ECHO_INPUT"
    && entry.command_base64 === commandBytes("ECHO_INPUT I09_B")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const bPayloadCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "ECHO_INPUT"
    && entry.command_base64 === commandBytes(bPayload)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const bPayloadPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input"
    && entry.id === "I09_B"
    && entry.phase === "payload"
    && entry.payload_base64 === bPayloadBase64
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  await pane.focus();
  await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  await pane.sendInput("ECHO_INPUT I09_B", true);
  await pane.sendInput(bPayload, true);
  const inputFrame = await inputFramePromise;

  const serverBPromise = waitForViewport(page, terminalId, "serverViewport", geometryB, false);
  const winchBPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "sigwinch"
    && entry.source === "signal"
    && entry.rows === geometryB.rows
    && entry.cols === geometryB.cols
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const pauseResumePromise = faultController.waitFor((event) => (
    event.type === "resumed"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  faultController.resume("browser-to-server", { terminalId });
  await pauseResumePromise;
  pause.dispose();
  const [serverB, winchB] = await Promise.all([serverBPromise, winchBPromise]);
  const bCommand = await bCommandPromise;
  await Promise.all([bPayloadCommandPromise, bPayloadPromise]);
  expect(bCommand.command_base64).toBe(commandBytes("ECHO_INPUT I09_B"));
  expect(serverB.serverViewport?.cols).toBe(geometryB.cols);
  expect(serverB.serverViewport?.rows).toBe(geometryB.rows);
  expect(winchB.rows).toBe(geometryB.rows);
  expect(winchB.cols).toBe(geometryB.cols);

  const networkFrames = faultController.events.filter((event) => browserFrame(event, terminalId));
  const resizeIndex = networkFrames.findIndex((event) => frameKey(event) === frameKey(resizeFrame));
  const inputIndex = networkFrames.findIndex((event) => frameKey(event) === frameKey(inputFrame));
  expect(resizeIndex).toBeGreaterThanOrEqual(0);
  expect(inputIndex).toBeGreaterThan(resizeIndex);

  const sizeCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "SIZE"
    && entry.command_base64 === commandBytes("SIZE I09_B")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const sizePromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "size"
    && entry.id === "I09_B"
    && entry.source === "ioctl"
    && entry.rows === geometryB.rows
    && entry.cols === geometryB.cols
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput("SIZE I09_B", true);
  await sizeCommandPromise;
  const sizeB = await sizePromise;
  expect(sizeB.rows).toBe(geometryB.rows);
  expect(sizeB.cols).toBe(geometryB.cols);
  await waitForTerminalBuffer(page, terminalId, {
    matches: new RegExp(`\\[E2E:SIZE:I09_B:${geometryB.rows}:${geometryB.cols}\\]`),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const wrapText = "W".repeat(Math.max(geometryB.cols + 32, 96));
  const wrapCommand = `PRINT I09_WRAP ${wrapText}`;
  const cPayload = "I09_C_PAYLOAD";
  const cPayloadBase64 = Buffer.from(cPayload, "utf8").toString("base64");
  const cCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "ECHO_INPUT"
    && entry.command_base64 === commandBytes("ECHO_INPUT I09_C")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const cPayloadCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "ECHO_INPUT"
    && entry.command_base64 === commandBytes(cPayload)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const cPayloadPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input"
    && entry.id === "I09_C"
    && entry.phase === "payload"
    && entry.payload_base64 === cPayloadBase64
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const wrapCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "PRINT"
    && entry.command_base64 === commandBytes(wrapCommand)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const wrapPrintPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print"
    && entry.id === "I09_WRAP"
    && entry.text === wrapText
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  const beforeAppliedInput = await screenshotRegion(page, terminalScreen);
  await pane.sendInput("ECHO_INPUT I09_C", true);
  await pane.sendInput(cPayload, true);
  await pane.sendInput(wrapCommand, true);
  await Promise.all([cCommandPromise, cPayloadCommandPromise, cPayloadPromise, wrapCommandPromise, wrapPrintPromise]);
  await waitForTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", "I09_C", cPayloadBase64),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await waitForTerminalBuffer(page, terminalId, { contains: "I09_WRAP" }, { timeout: WAIT_TIMEOUT_MS });
  const afterAppliedInput = await screenshotRegion(page, terminalScreen);
  await expectTerminalPixelsChanged(beforeAppliedInput, afterAppliedInput, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "i-09-applied-input-crop",
  });
  await expectTerminalNonBlank(page, terminalScreen, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "i-09-terminal-crop",
  });

  await pane.focus();
  await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  const afterPayload = "I09_AFTER_PAYLOAD";
  const afterPayloadBase64 = Buffer.from(afterPayload, "utf8").toString("base64");
  const afterCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "ECHO_INPUT"
    && entry.command_base64 === commandBytes("ECHO_INPUT I09_AFTER")
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const afterPayloadCommandPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "ECHO_INPUT"
    && entry.command_base64 === commandBytes(afterPayload)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const afterPayloadPromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input"
    && entry.id === "I09_AFTER"
    && entry.phase === "payload"
    && entry.payload_base64 === afterPayloadBase64
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput("ECHO_INPUT I09_AFTER", true);
  await pane.sendInput(afterPayload, true);
  await Promise.all([afterCommandPromise, afterPayloadCommandPromise, afterPayloadPromise]);
  await waitForTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", "I09_AFTER", afterPayloadBase64),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const finalSnapshot = await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(finalSnapshot.socketGeneration).toBe(generation);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.acceptingInput).toBe(true);
  await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused();
  expect(finalSnapshot.cols).toBe(geometryB.cols);
  expect(finalSnapshot.rows).toBe(geometryB.rows);
  expect(finalSnapshot.desiredViewport?.cols).toBe(geometryB.cols);
  expect(finalSnapshot.desiredViewport?.rows).toBe(geometryB.rows);
  expect(finalSnapshot.sentViewport?.cols).toBe(geometryB.cols);
  expect(finalSnapshot.sentViewport?.rows).toBe(geometryB.rows);
  expect(finalSnapshot.serverViewport?.cols).toBe(geometryB.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(geometryB.rows);
  expect(finalSnapshot.gridEpoch).toEqual(expect.any(Number));

  const model = compactModel(finalSnapshot.xterm.text);
  const expectedMarkers = [
    marker("READY", "I09"),
    marker("PRINT", "I09_A", baselineText),
    marker("ECHO_INPUT", "I09_B", "READY"),
    marker("ECHO_INPUT", "I09_B", bPayloadBase64),
    marker("SIZE", "I09_B", String(geometryB.rows), String(geometryB.cols)),
    marker("ECHO_INPUT", "I09_C", "READY"),
    marker("ECHO_INPUT", "I09_C", cPayloadBase64),
    marker("ECHO_INPUT", "I09_AFTER", "READY"),
    marker("ECHO_INPUT", "I09_AFTER", afterPayloadBase64),
  ];
  for (const expectedMarker of expectedMarkers) {
    expect(model).toContain(expectedMarker);
    expect(occurrences(model, expectedMarker)).toBe(1);
  }
  const compactWrapMarker = marker("PRINT", "I09_WRAP", wrapText);
  expect(model).toContain(compactWrapMarker);
  expect(occurrences(model, compactWrapMarker)).toBe(1);
  const modelLines = finalSnapshot.xterm.text.split(/\r?\n/);
  expect(modelLines.some((line) => line.length === geometryB.cols)).toBe(true);
  expect(finalSnapshot.xterm.activeBuffer).toBe("normal");

  const finalEvents = await terminalEvents(page, terminalId);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  await assertMonotonicSequences(finalEvents);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(browserErrors).toEqual([]);

  const transcript = await server.readTranscript(terminalId);
  const submitted = transcript.filter((entry) => entry.event === "command");
  expect(submitted.map((entry) => entry.command_base64)).toEqual([
    commandBytes("READY I09"),
    commandBytes(baselineCommand),
    commandBytes("ECHO_INPUT I09_B"),
    commandBytes(bPayload),
    commandBytes("SIZE I09_B"),
    commandBytes("ECHO_INPUT I09_C"),
    commandBytes(cPayload),
    commandBytes(wrapCommand),
    commandBytes("ECHO_INPUT I09_AFTER"),
    commandBytes(afterPayload),
  ]);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === "I09_A")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === "I09_WRAP")).toHaveLength(1);
  for (const id of ["I09_B", "I09_C", "I09_AFTER"]) {
    expect(
      transcript
        .filter((entry) => entry.event === "echo_input" && entry.id === id)
        .map((entry) => entry.phase),
    ).toEqual(["armed", "payload"]);
  }
  const payloadEntries = transcript.filter((entry) => entry.event === "echo_input" && entry.phase === "payload");
  expect(payloadEntries).toHaveLength(3);
  expect(payloadEntries.map((entry) => entry.payload_base64)).toEqual([
    bPayloadBase64,
    cPayloadBase64,
    afterPayloadBase64,
  ]);
  const winches = transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
  expect(winches.length).toBeGreaterThanOrEqual(2);
  const latestWinch = winches.at(-1);
  expect(latestWinch?.rows).toBe(geometryB.rows);
  expect(latestWinch?.cols).toBe(geometryB.cols);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);
});
