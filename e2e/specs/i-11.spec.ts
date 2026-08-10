import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { test, expect, type TranscriptEntry } from "../fixtures/test.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConnected,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalBuffer,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { TERMINAL_ACK_BYTES } from "../../src/client/lib/terminal-stream.js";

const INPUT_CHUNK_BYTES = 16 * 1024;
const INPUT_QUEUE_BYTES = 1024 * 1024;
const INPUT_QUEUE_MESSAGES = 64;
const INPUT_QUEUE_FULL_ERROR = "terminal input queue is full; wait for the terminal to catch up";
const HOLD_TOKEN = "I11";
const LARGE_LINE_BYTES = 16_384;
const LARGE_LINE_COUNT = 80;

const asString = (entry: TranscriptEntry, key: string): string | undefined => {
  const value = entry[key];
  return typeof value === "string" ? value : undefined;
};

const countOccurrences = (value: string, needle: string): number => {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
};

const terminalIdFromWorkbench = async (page: Page): Promise<string> => {
  const terminal = page.locator(".editor-grid [data-terminal-id]").first();
  await expect(terminal).toBeVisible();
  const terminalId = await terminal.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal did not expose a terminal ID");
  return terminalId;
};


const browserInputFrames = (events: readonly { readonly type: string; readonly terminalId?: string; readonly direction?: string; readonly frame?: { readonly opcode?: number; readonly bytes?: number; readonly fin?: boolean } }[], terminalId: string) => (
  events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
    && event.frame?.opcode === 2
  ))
);

const payloadBytesFromFrame = (bytes: number): number => bytes >= 126 ? bytes - 8 : bytes - 6;

const assertAcceptedPrefix = (payload: Uint8Array, entries: readonly TranscriptEntry[]): number => {
  const malformed = entries.filter((entry) => entry.event === "command" && entry.operation === "MALFORMED");
  expect(malformed.length, "the held burst must have a bounded finite accepted prefix").toBeGreaterThan(0);
  expect(malformed.length, "the held burst must not accept more than the message bound").toBeLessThanOrEqual(INPUT_QUEUE_MESSAGES);

  let offset = 0;
  for (const entry of malformed) {
    const encoded = asString(entry, "command_base64");
    if (!encoded) throw new Error("fixture malformed command omitted command_base64");
    const line = Buffer.from(encoded, "base64");
    expect(payload.subarray(offset, offset + line.length)).toEqual(line);
    offset += line.length;
    if (payload[offset] === 0x0a) offset += 1;
  }

  expect(offset, "the fixture must receive a strict finite prefix of the burst").toBeGreaterThan(0);
  expect(offset, "the fixture must not receive bytes beyond the 1 MiB input queue").toBeLessThanOrEqual(INPUT_QUEUE_BYTES);
  expect(offset).toBeLessThan(payload.byteLength);
  return offset;
};

test("I-11 Large input backpressure @nightly @input @backpressure @large", async ({ page, baseURL, server, faultController }, testInfo) => {
  const errorCollector = installBrowserErrorCollectors(page);
  const browserErrorCountAtStart = errorCollector().length;
  await page.goto(baseURL);
  await new LoginPage(page).login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();
  const terminalId = await terminalIdFromWorkbench(page);
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalConnected(page, terminalId);
  await expectTerminalSynchronized(page, terminalId);
  await pane.sendInput("READY I11", true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === "I11");
  await expectTerminalBuffer(page, terminalId, { contains: "[E2E:READY:I11]", occurrences: 1 });
  await pane.sendInput("SIZE I11", true);
  const sizeEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === "I11");
  const initialSnapshot = await terminalSnapshot(page, terminalId);
  if (!initialSnapshot) throw new Error("missing diagnostics snapshot after fixture SIZE");
  expect(sizeEntry.rows).toBe(initialSnapshot.rows);
  expect(sizeEntry.cols).toBe(initialSnapshot.cols);

  await pane.sendInput(`HOLD ${HOLD_TOKEN}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === HOLD_TOKEN);
  const beforeBurst = await screenshotRegion(page, pane.xtermHost);

  const largePayload = `${"x".repeat(LARGE_LINE_BYTES)}\n`.repeat(LARGE_LINE_COUNT);
  const encodedPayload = new TextEncoder().encode(largePayload);
  const expectedChunkCount = Math.ceil(encodedPayload.byteLength / INPUT_CHUNK_BYTES);
  const burstFrameStart = faultController.events.length;
  const pauseRule = faultController.pause("browser-to-server", { terminalId });
  await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
  ), { timeoutMs: 15_000 });

  await pane.insertText(largePayload);
  await faultController.waitFor((event) => (
    browserInputFrames(faultController.events.slice(burstFrameStart), terminalId).length >= expectedChunkCount
    && event.type === "frame"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
  ), { timeoutMs: 60_000 });

  const preparedFrames = browserInputFrames(faultController.events.slice(burstFrameStart), terminalId);
  expect(preparedFrames.length).toBe(expectedChunkCount);
  const preparedChunkSizes = preparedFrames.map((event) => {
    const bytes = event.frame?.bytes;
    expect(bytes).toBeDefined();
    expect(event.frame?.fin).toBe(true);
    const payloadBytes = payloadBytesFromFrame(bytes!);
    expect(payloadBytes).toBeGreaterThan(0);
    expect(payloadBytes).toBeLessThanOrEqual(INPUT_CHUNK_BYTES);
    return payloadBytes;
  });
  expect(preparedChunkSizes.slice(0, -1).every((bytes) => bytes === INPUT_CHUNK_BYTES)).toBe(true);
  expect(preparedChunkSizes.at(-1)).toBe(encodedPayload.byteLength % INPUT_CHUNK_BYTES || INPUT_CHUNK_BYTES);

  faultController.resume("browser-to-server", { terminalId });
  await faultController.waitFor((event) => (
    event.type === "resumed"
    && event.terminalId === terminalId
    && event.direction === "browser-to-server"
  ), { timeoutMs: 15_000 });
  pauseRule.dispose();

  const fullErrorNotice = page.locator('.toast[role="status"]').filter({ hasText: INPUT_QUEUE_FULL_ERROR });
  await expect(fullErrorNotice).toBeVisible({ timeout: 60_000 });
  const afterRejection = await expectTerminalConnected(page, terminalId);
  expect(afterRejection.acceptingInput).toBe(true);

  await pane.sendInput(`RELEASE ${HOLD_TOKEN}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === HOLD_TOKEN, { timeoutMs: 60_000 });
  await pane.sendInput("ECHO_INPUT I11_AFTER OK", true);
  await pane.sendInput("PRINT I11_LIVE", true);

  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === "I11_AFTER" && entry.phase === "payload" && entry.text === "OK",
    { timeoutMs: 90_000 },
  );
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === "I11_LIVE",
    { timeoutMs: 90_000 },
  );

  const transcript = await server.readTranscript(terminalId);
  const acceptedPrefixBytes = assertAcceptedPrefix(encodedPayload, transcript);
  expect(acceptedPrefixBytes).toBeLessThanOrEqual(INPUT_QUEUE_BYTES);

  const finalSnapshot = await waitForTerminalBuffer(page, terminalId, {
    contains: "[E2E:ECHO_INPUT:I11_AFTER:OK]",
    occurrences: 1,
    matches: /\[E2E:PRINT:I11_LIVE\]/,
  }, { timeout: 90_000 });
  expect(finalSnapshot.xterm.text).toContain("[E2E:PRINT:I11_LIVE]");
  expect(countOccurrences(finalSnapshot.xterm.text, "[E2E:ECHO_INPUT:I11_AFTER:OK]")).toBe(1);
  expect(countOccurrences(finalSnapshot.xterm.text, "[E2E:PRINT:I11_LIVE]")).toBe(1);

  const settledSnapshot = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeSocketCount: 1,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: 90_000 });
  await expectNoPendingRecovery(page, terminalId, { timeout: 30_000 });
  await expectSingleTerminalSocket(page, terminalId, { timeout: 15_000 });
  expect(settledSnapshot.acceptingInput).toBe(true);
  expect(settledSnapshot.socket.activeCount).toBe(1);
  expect(settledSnapshot.syncMode).toBeUndefined();
  expect(settledSnapshot.flowPendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(settledSnapshot.flow.pendingAcknowledgementBytes).toBeLessThan(TERMINAL_ACK_BYTES);
  expect(settledSnapshot.serverViewport?.cols).toBe(settledSnapshot.cols);
  expect(settledSnapshot.serverViewport?.rows).toBe(settledSnapshot.rows);

  const events = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(events.filter((event) => event.type === "socket-close" || event.type === "socket-stale")).toEqual([]);
  expect(events.filter((event) => event.type === "sync").length).toBe(1);

  const finalCrop = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforeBurst, finalCrop, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "i11-final-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "i11-nonblank-crop",
  });

  const unexpectedBrowserErrors = errorCollector().slice(browserErrorCountAtStart).filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || (entry.kind === "console" && /^error:/i.test(entry.message))
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);

  const commandEntries = transcript.filter((entry) => entry.event === "command");
  const expectedCommands = ["READY I11", "HOLD I11", "RELEASE I11", "ECHO_INPUT I11_AFTER OK", "PRINT I11_LIVE"];
  for (const command of expectedCommands) {
    const encoded = Buffer.from(command, "utf8").toString("base64");
    expect(commandEntries.filter((entry) => asString(entry, "command_base64") === encoded).length).toBe(1);
  }
});
