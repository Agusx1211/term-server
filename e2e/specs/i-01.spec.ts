import { test, expect } from "../fixtures/test.js";
import { screenshotRegion, expectTerminalNonBlank, expectTerminalPixelsChanged } from "../assertions/terminal-pixels.js";
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
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function marker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]`;
}

test("I-01 Basic typing and Enter @nightly @input @basic @pr", async ({ page, server }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/");
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
  await expectTerminalSynchronized(page, terminalId);
  await expectTerminalConnected(page, terminalId);
  await pane.focus();

  const diagnosticsApiInstalled = await page.evaluate(() => Boolean(
    (window as Window & { __TERM_SERVER_E2E__?: unknown }).__TERM_SERVER_E2E__,
  ));
  expect(diagnosticsApiInstalled).toBe(true);

  await pane.sendInput("READY I01", true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "READY"
    && entry.command_base64 === commandBytes("READY I01")
  ));
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === "I01");
  await waitForTerminalBuffer(page, terminalId, { contains: marker("READY", "I01"), occurrences: 1 });
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "sigwinch" && entry.source === "signal"
  ));

  const before = await screenshotRegion(page, pane.xtermHost);

  await pane.sendInput("PRINT I01 OUT", true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "PRINT"
    && entry.command_base64 === commandBytes("PRINT I01 OUT")
  ));
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === "I01" && entry.text === "OUT"
  ));
  await waitForTerminalBuffer(page, terminalId, {
    contains: marker("PRINT", "I01", "OUT"),
    occurrences: 1,
  });

  await pane.sendInput("ECHO_INPUT I01 ALPHA", true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "ECHO_INPUT"
    && entry.command_base64 === commandBytes("ECHO_INPUT I01 ALPHA")
  ));
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input"
    && entry.id === "I01"
    && entry.phase === "payload"
    && entry.text === "ALPHA"
  ));
  await waitForTerminalBuffer(page, terminalId, {
    contains: marker("ECHO_INPUT", "I01", "ALPHA"),
    occurrences: 1,
  });

  const after = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(before, after, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "i-01-after-input-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "i-01-terminal-crop",
  });

  const snapshotBeforeSize = await terminalSnapshot(page, terminalId);
  if (!snapshotBeforeSize) throw new Error("terminal diagnostics snapshot disappeared");
  expect(snapshotBeforeSize.xterm.text).toContain(marker("PRINT", "I01", "OUT"));
  expect(snapshotBeforeSize.xterm.text).toContain(marker("ECHO_INPUT", "I01", "ALPHA"));
  expect(snapshotBeforeSize.xterm.text.match(/\[E2E:PRINT:I01:OUT\]/g)).toHaveLength(1);
  expect(snapshotBeforeSize.xterm.text.match(/\[E2E:ECHO_INPUT:I01:ALPHA\]/g)).toHaveLength(1);
  expect(snapshotBeforeSize.socketState).toBe("connected");
  expect(snapshotBeforeSize.syncMode).toBeUndefined();
  expect(snapshotBeforeSize.syncTarget).toBeUndefined();
  expect(snapshotBeforeSize.pendingParserWrites).toBe(0);
  expect(snapshotBeforeSize.renderBacklogBytes).toBe(0);

  const receivedBefore = snapshotBeforeSize.receivedSequence;
  const committedBefore = snapshotBeforeSize.committedSequence;
  expect(receivedBefore).toEqual(expect.any(Number));
  expect(committedBefore).toEqual(expect.any(Number));

  await pane.sendInput("SIZE I01", true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "SIZE"
    && entry.command_base64 === commandBytes("SIZE I01")
  ));
  const sizeEntry = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "size" && entry.id === "I01" && entry.source === "ioctl"
  ));
  expect(sizeEntry.rows).toEqual(expect.any(Number));
  expect(sizeEntry.cols).toEqual(expect.any(Number));
  await waitForTerminalBuffer(page, terminalId, { matches: /\[E2E:SIZE:I01:\d+:\d+\]/ });

  const finalSnapshot = await expectTerminalConnected(page, terminalId);
  await expectNoPendingRecovery(page, terminalId);
  await expectSingleTerminalSocket(page, terminalId);
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.socketGeneration).toBe(1);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.receivedSequence).toBeGreaterThan(receivedBefore as number);
  expect(finalSnapshot.committedSequence).toBeGreaterThan(committedBefore as number);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.serverViewport).toBeDefined();
  expect(finalSnapshot.serverViewport?.cols).toBe(finalSnapshot.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(finalSnapshot.rows);
  expect(finalSnapshot.serverViewport?.pixelWidth).toBe(finalSnapshot.pixelWidth);
  expect(finalSnapshot.serverViewport?.pixelHeight).toBe(finalSnapshot.pixelHeight);
  expect(sizeEntry.cols).toBe(finalSnapshot.cols);
  expect(sizeEntry.rows).toBe(finalSnapshot.rows);
  expect(sizeEntry.pixel_width).toBe(finalSnapshot.pixelWidth);
  expect(sizeEntry.pixel_height).toBe(finalSnapshot.pixelHeight);
  const finalEvents = await terminalEvents(page, terminalId);
  expect(finalEvents.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(finalEvents.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  expect(finalEvents.filter((event) => event.type === "error")).toHaveLength(0);
  await assertMonotonicSequences(finalEvents);
  await expectConnectedTerminalInvariants(page, terminalId);

  const transcript = await server.readTranscript(terminalId);
  const winchEntries = transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal");
  expect(winchEntries.length).toBeGreaterThan(0);
  const latestWinch = winchEntries[winchEntries.length - 1];
  if (!latestWinch) throw new Error("SIGWINCH transcript entry disappeared");
  expect(latestWinch.rows).toBe(finalSnapshot.rows);
  expect(latestWinch.cols).toBe(finalSnapshot.cols);
  expect(latestWinch.pixel_width).toBe(finalSnapshot.pixelWidth);
  expect(latestWinch.pixel_height).toBe(finalSnapshot.pixelHeight);
  const submitted = transcript.filter((entry) => (
    entry.event === "command" && (entry.operation === "PRINT" || entry.operation === "ECHO_INPUT")
  ));
  expect(submitted.map((entry) => entry.command_base64)).toEqual([
    commandBytes("PRINT I01 OUT"),
    commandBytes("ECHO_INPUT I01 ALPHA"),
  ]);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === "I01")).toHaveLength(1);
  expect(transcript.filter((entry) => (
    entry.event === "echo_input" && entry.id === "I01" && entry.phase === "payload"
  ))).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "start")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "exit")).toHaveLength(0);
  expect(browserErrors).toEqual([]);
});
