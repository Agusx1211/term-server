import { test, expect } from "../fixtures/test.js";
import type { IsolatedServer } from "../fixtures/test.js";
import { LoginPage } from "../pages/login-page.js";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type { TerminalPixelImage } from "../assertions/terminal-pixels.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";
import type { BrowserContext, Page } from "@playwright/test";

type TranscriptEntry = Record<string, unknown>;
type E2EWindow = Window & { __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi };

const OSC52_PERMISSIONS = ["clipboard-read", "clipboard-write"] as const;
const CLIPBOARD_DENIED_NOTICE = "Clipboard permission was denied";
const CLIPBOARD_UNAVAILABLE_NOTICE = "Clipboard access requires HTTPS or localhost";

const encodeBase64 = (value: string | Uint8Array): string => Buffer.from(value).toString("base64");

const transcriptSequence = (entry: TranscriptEntry): number => (
  typeof entry.sequence === "number" && Number.isFinite(entry.sequence) ? entry.sequence : 0
);

async function transcriptFloor(server: IsolatedServer, terminalId: string): Promise<number> {
  const entries = await server.readTranscript(terminalId);
  return entries.reduce((floor, entry) => Math.max(floor, transcriptSequence(entry)), 0);
}

async function waitForTerminalText(
  page: Page,
  terminalId: string,
  marker: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, text }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.text.replaceAll("\n", "").includes(text.replaceAll("\n", "")),
      { timeout: 15_000 },
    );
  }, { id: terminalId, text: marker });
}

async function waitForTerminalSettled(
  page: Page,
  terminalId: string,
  marker: string,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, text }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(
      id,
      (snapshot) => snapshot.text.replaceAll("\n", "").includes(text.replaceAll("\n", ""))
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0,
      { timeout: 15_000 },
    );
  }, { id: terminalId, text: marker });
}

function fixtureMarker(operation: string, ...fields: string[]): string {
  return `[E2E:${operation}:${fields.join(":")}]\n`;
}

function fixtureEscapeSequence(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    if (byte === 0x1b) encoded += "\\x1b";
    else if (byte === 0x07) encoded += "\\x07";
    else if (byte === 0x08) encoded += "\\x08";
    else if (byte === 0x09) encoded += "\\t";
    else if (byte === 0x0a) encoded += "\\n";
    else if (byte === 0x0d) encoded += "\\r";
    else if (byte === 0x5c) encoded += "\\\\";
    else encoded += String.fromCharCode(byte);
  }
  return encoded;
}

async function sendFixtureLine(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  command: string,
  writes: readonly Uint8Array[] = [],
): Promise<void> {
  const floor = await transcriptFloor(server, terminalId);
  const commandBase64 = encodeBase64(command);
  const commandWait = server.waitForTranscript<TranscriptEntry>(
    terminalId,
    (entry) => transcriptSequence(entry) > floor
      && entry.event === "command"
      && entry.command_base64 === commandBase64,
  );
  const writeWaits = writes.map((bytes) => server.waitForTranscript<TranscriptEntry>(
    terminalId,
    (entry) => transcriptSequence(entry) > floor
      && entry.event === "write"
      && entry.data_base64 === encodeBase64(bytes),
  ));

  await pane.insertText(command);
  await pane.press("Enter");
  await commandWait;
  await Promise.all(writeWaits);
}

async function sendFixturePrint(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
): Promise<string> {
  const text = "I07_AFTER";
  const marker = fixtureMarker("PRINT", id, text);
  await sendFixtureLine(
    pane,
    server,
    terminalId,
    `PRINT ${id} ${text}`,
    [Buffer.from(marker)],
  );
  await waitForTerminalSettled(pane.page, terminalId, marker);
  return marker;
}

async function sendFixtureEcho(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
): Promise<void> {
  const text = "I07_ACTIVE";
  const marker = fixtureMarker("ECHO_INPUT", id, text);
  await sendFixtureLine(
    pane,
    server,
    terminalId,
    `ECHO_INPUT ${id} ${text}`,
    [Buffer.from(marker)],
  );
  await waitForTerminalSettled(pane.page, terminalId, marker);
}

async function sendFixtureOsc52(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  id: string,
  sequence: Uint8Array,
): Promise<string> {
  const marker = fixtureMarker("ESCAPE_SPLIT", id);
  const split = 1;
  const command = `ESCAPE_SPLIT ${id} ${fixtureEscapeSequence(sequence)} ${split}`;
  await sendFixtureLine(
    pane,
    server,
    terminalId,
    command,
    [sequence.slice(0, split), sequence.slice(split), Buffer.from(marker)],
  );
  await waitForTerminalSettled(pane.page, terminalId, marker);
  return marker;
}

async function flushPermittedOsc52Read(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  expectedReply: Uint8Array,
): Promise<void> {
  const floor = await transcriptFloor(server, terminalId);
  const replyBase64 = encodeBase64(expectedReply);
  const replyWait = server.waitForTranscript<TranscriptEntry>(
    terminalId,
    (entry) => transcriptSequence(entry) > floor
      && entry.event === "error"
      && entry.operation === "command"
      && entry.command_base64 === replyBase64,
  );
  await pane.press("Enter");
  const reply = await replyWait;
  expect(reply.command_base64).toBe(replyBase64);

  const duplicateReplies = (await server.readTranscript(terminalId)).filter((entry) => (
    transcriptSequence(entry) > floor
      && entry.event === "error"
      && entry.operation === "command"
      && entry.command_base64 === replyBase64
  ));
  expect(duplicateReplies).toHaveLength(1);
}

async function flushDeniedOsc52Read(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  oscPrefix: Uint8Array,
): Promise<void> {
  const floor = await transcriptFloor(server, terminalId);
  await pane.press("Enter");
  const entries = await server.readTranscript(terminalId);
  const leakedReplies = entries.filter((entry) => {
    if (transcriptSequence(entry) <= floor || entry.event !== "error" || entry.operation !== "command") return false;
    if (typeof entry.command_base64 !== "string") return false;
    const bytes = Buffer.from(entry.command_base64, "base64");
    return bytes.length >= oscPrefix.length && bytes.subarray(0, oscPrefix.length).equals(oscPrefix);
  });
  expect(leakedReplies).toHaveLength(0);
}

async function createTerminal(
  page: Page,
  baseURL: string,
): Promise<{ readonly pane: TerminalPanePage; readonly terminalId: string }> {
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();
  const terminalElement = workbench.editorGrid.locator("[data-terminal-id]").first();
  await expect(terminalElement).toHaveAttribute("data-terminal-id", /.+/);
  const terminalId = await terminalElement.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("new terminal did not expose a stable terminal ID");
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  await pane.waitForSynchronized();
  return { pane, terminalId };
}

async function assertHealthyTerminal(
  page: Page,
  pane: TerminalPanePage,
  terminalId: string,
  markers: readonly string[],
): Promise<void> {
  for (const marker of markers) {
    const snapshot = await pane.snapshot();
    if (!snapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
    expect(snapshot.text).toContain(marker);
  }
  const report = await expectConnectedTerminalInvariants(page, terminalId);
  await expectNoPendingRecovery(page, terminalId);
  await assertMonotonicSequences(report.events);
  expect(report.violations).toEqual([]);
  expect(report.snapshot.socketState).toBe("connected");
  expect(report.snapshot.activeSocketCount).toBe(1);
  expect(report.snapshot.syncMode).toBeUndefined();
  expect(report.snapshot.pendingParserWrites).toBe(0);
  expect(report.snapshot.pendingParserBytes).toBe(0);
  expect(report.snapshot.renderBacklogBytes).toBe(0);
  expect(report.snapshot.renderBacklogFrames).toBe(0);
  expect(report.snapshot.serverViewport?.cols).toBe(report.snapshot.cols);
  expect(report.snapshot.serverViewport?.rows).toBe(report.snapshot.rows);
  expect((await pane.events()).filter((event) => event.type === "error")).toHaveLength(0);
}

async function grantClipboard(context: BrowserContext, origin: string): Promise<void> {
  await context.grantPermissions([...OSC52_PERMISSIONS], { origin });
}

async function setClipboard(page: Page, value: string): Promise<void> {
  await page.evaluate(async (text) => {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API writeText is unavailable");
    await navigator.clipboard.writeText(text);
  }, value);
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(async () => {
    if (!navigator.clipboard?.readText) throw new Error("Clipboard API readText is unavailable");
    return navigator.clipboard.readText();
  });
}

function osc52Write(payload: string): Uint8Array {
  return Buffer.from(`\x1b]52;c;${encodeBase64(payload)}\x07`);
}

function osc52Read(): Uint8Array {
  return Buffer.from("\x1b]52;c;?\x07");
}

function osc52Reply(payload: string): Uint8Array {
  return Buffer.from(`\x1b]52;c;${encodeBase64(payload)}\x07`);
}

const osc52Prefix = Buffer.from("\x1b]52;c;");

async function assertChangedAndNonBlank(
  page: Page,
  pane: TerminalPanePage,
  before: TerminalPixelImage,
): Promise<void> {
  const after = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(before, after, { minimumChangedRatio: 0.002 });
  await expectTerminalNonBlank(page, pane.xtermHost, { minimumNonBackgroundRatio: 0.002 });
}

test.describe("I-07 OSC 52 clipboard @nightly @input @osc52 @clipboard", () => {
  test("permitted OSC 52 read/write and responder isolation", async ({ page, baseURL, browser, server }) => {
    await page.goto(baseURL);
    const hasClipboard = await page.evaluate(() => Boolean(navigator.clipboard));
    test.skip(!hasClipboard, "OSC 52 permitted branch skipped: this browser has no navigator.clipboard; unavailable branch covers that capability");

    await grantClipboard(page.context(), new URL(baseURL).origin);
    const { pane, terminalId } = await createTerminal(page, baseURL);
    const contextB = await browser.newContext({ baseURL });
    try {
      await grantClipboard(contextB, new URL(baseURL).origin);
      const pageB = await contextB.newPage();
      const loginB = new LoginPage(pageB);
      await pageB.goto(baseURL);
      await loginB.login();
      const workbenchB = new WorkbenchPage(pageB);
      await workbenchB.expectVisible();
      const paneB = await workbenchB.openTerminal({ id: terminalId });
      await paneB.expectVisible();
      await paneB.waitForSynchronized();

      await pane.focus();
      await sendFixtureEcho(pane, server, terminalId, "I07_A_ACTIVATE");
      const beforeAWrite = await screenshotRegion(page, pane.xtermHost);
      const writePayloadA = "OSC52-WRITE-I07-A";
      await sendFixtureOsc52(pane, server, terminalId, "I07_A_WRITE", osc52Write(writePayloadA));
      expect(await readClipboard(page)).toBe(writePayloadA);
      const aWriteMarker = await sendFixturePrint(pane, server, terminalId, "I07_A_WRITE_AFTER");
      await assertChangedAndNonBlank(page, pane, beforeAWrite);

      const readPayloadA = "OSC52-READ-I07-A";
      await setClipboard(page, readPayloadA);
      await sendFixtureOsc52(pane, server, terminalId, "I07_A_READ", osc52Read());
      await flushPermittedOsc52Read(pane, server, terminalId, osc52Reply(readPayloadA));
      const aReadMarker = await sendFixturePrint(pane, server, terminalId, "I07_A_READ_AFTER");

      await paneB.focus();
      await sendFixtureEcho(paneB, server, terminalId, "I07_B_ACTIVATE");
      const beforeBWrite = await screenshotRegion(pageB, paneB.xtermHost);
      const writePayloadB = "OSC52-WRITE-I07-B";
      await sendFixtureOsc52(paneB, server, terminalId, "I07_B_WRITE", osc52Write(writePayloadB));
      expect(await readClipboard(pageB)).toBe(writePayloadB);
      const bWriteMarker = await sendFixturePrint(paneB, server, terminalId, "I07_B_WRITE_AFTER");
      await assertChangedAndNonBlank(pageB, paneB, beforeBWrite);

      const readPayloadB = "OSC52-READ-I07-B";
      await setClipboard(pageB, readPayloadB);
      await sendFixtureOsc52(paneB, server, terminalId, "I07_B_READ", osc52Read());
      await flushPermittedOsc52Read(paneB, server, terminalId, osc52Reply(readPayloadB));
      const bReadMarker = await sendFixturePrint(paneB, server, terminalId, "I07_B_READ_AFTER");

      const transcript = await server.readTranscript(terminalId);
      const commandLines = transcript.filter((entry) => entry.event === "command");
      for (const command of [
        "ECHO_INPUT I07_A_ACTIVATE I07_ACTIVE",
        "ECHO_INPUT I07_B_ACTIVATE I07_ACTIVE",
        "PRINT I07_A_WRITE_AFTER I07_AFTER",
        "PRINT I07_A_READ_AFTER I07_AFTER",
        "PRINT I07_B_WRITE_AFTER I07_AFTER",
        "PRINT I07_B_READ_AFTER I07_AFTER",
      ]) {
        expect(commandLines.filter((entry) => entry.command_base64 === encodeBase64(command))).toHaveLength(1);
      }
      const writeA = osc52Write(writePayloadA);
      const writeB = osc52Write(writePayloadB);
      expect(transcript.filter((entry) => entry.event === "write" && entry.data_base64 === encodeBase64(writeA.slice(0, 1)))).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "write" && entry.data_base64 === encodeBase64(writeA.slice(1)))).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "write" && entry.data_base64 === encodeBase64(writeB.slice(0, 1)))).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "write" && entry.data_base64 === encodeBase64(writeB.slice(1)))).toHaveLength(1);
      const expectedReplyA = encodeBase64(osc52Reply(readPayloadA));
      const expectedReplyB = encodeBase64(osc52Reply(readPayloadB));
      expect(transcript.filter((entry) => entry.event === "error" && entry.operation === "command" && entry.command_base64 === expectedReplyA)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "error" && entry.operation === "command" && entry.command_base64 === expectedReplyB)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "error" && entry.operation === "command")).toHaveLength(2);

      await assertHealthyTerminal(page, pane, terminalId, [aWriteMarker, aReadMarker, bWriteMarker, bReadMarker]);
      await assertHealthyTerminal(pageB, paneB, terminalId, [aWriteMarker, aReadMarker, bWriteMarker, bReadMarker]);
    } finally {
      await contextB.close();
    }
  });

  test("denied OSC 52 read/write keeps parsing alive", async ({ page, baseURL, browser, server }) => {
    await page.goto(baseURL);
    const hasClipboard = await page.evaluate(() => Boolean(navigator.clipboard));
    test.skip(!hasClipboard, "OSC 52 denied branch skipped: this browser has no navigator.clipboard; unavailable branch covers that capability");
    await page.context().clearPermissions();

    const { pane, terminalId } = await createTerminal(page, baseURL);
    const probeContext = await browser.newContext({ baseURL });
    try {
      await grantClipboard(probeContext, new URL(baseURL).origin);
      const probePage = await probeContext.newPage();
      await probePage.goto(baseURL);
      const sentinel = "OSC52-DENIED-SENTINEL-I07";
      await setClipboard(probePage, sentinel);

      const beforeWrite = await screenshotRegion(page, pane.xtermHost);
      await sendFixtureOsc52(pane, server, terminalId, "I07_DENIED_WRITE", osc52Write("OSC52-DENIED-WRITE-I07"));
      await expect(page.getByRole("status")).toHaveText(CLIPBOARD_DENIED_NOTICE);
      const deniedWriteMarker = await sendFixturePrint(pane, server, terminalId, "I07_DENIED_WRITE_AFTER");
      expect(await readClipboard(probePage)).toBe(sentinel);
      await assertChangedAndNonBlank(page, pane, beforeWrite);

      const beforeRead = await screenshotRegion(page, pane.xtermHost);
      await sendFixtureOsc52(pane, server, terminalId, "I07_DENIED_READ", osc52Read());
      await expect(page.getByRole("status")).toHaveText(CLIPBOARD_DENIED_NOTICE);
      await flushDeniedOsc52Read(pane, server, terminalId, osc52Prefix);
      const deniedReadMarker = await sendFixturePrint(pane, server, terminalId, "I07_DENIED_READ_AFTER");
      await assertChangedAndNonBlank(page, pane, beforeRead);

      const transcript = await server.readTranscript(terminalId);
      const commandLines = transcript.filter((entry) => entry.event === "command");
      expect(commandLines.filter((entry) => entry.command_base64 === encodeBase64("PRINT I07_DENIED_WRITE_AFTER I07_AFTER"))).toHaveLength(1);
      expect(commandLines.filter((entry) => entry.command_base64 === encodeBase64("PRINT I07_DENIED_READ_AFTER I07_AFTER"))).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "error" && entry.operation === "command")).toHaveLength(0);

      await assertHealthyTerminal(page, pane, terminalId, [deniedWriteMarker, deniedReadMarker]);
    } finally {
      await probeContext.close();
    }
  });

  test("unavailable OSC 52 read/write keeps parsing alive", async ({ page, baseURL, server }) => {
    await page.goto(baseURL);
    const hasClipboard = await page.evaluate(() => Boolean(navigator.clipboard));
    test.skip(hasClipboard, "OSC 52 unavailable branch skipped: navigator.clipboard is available in this browser");

    const { pane, terminalId } = await createTerminal(page, baseURL);
    const beforeWrite = await screenshotRegion(page, pane.xtermHost);
    await sendFixtureOsc52(pane, server, terminalId, "I07_UNAVAILABLE_WRITE", osc52Write("OSC52-UNAVAILABLE-WRITE-I07"));
    await expect(page.getByRole("status")).toHaveText(CLIPBOARD_UNAVAILABLE_NOTICE);
    const unavailableWriteMarker = await sendFixturePrint(pane, server, terminalId, "I07_UNAVAILABLE_WRITE_AFTER");
    await assertChangedAndNonBlank(page, pane, beforeWrite);

    const beforeRead = await screenshotRegion(page, pane.xtermHost);
    await sendFixtureOsc52(pane, server, terminalId, "I07_UNAVAILABLE_READ", osc52Read());
    await expect(page.getByRole("status")).toHaveText(CLIPBOARD_UNAVAILABLE_NOTICE);
    await flushDeniedOsc52Read(pane, server, terminalId, osc52Prefix);
    const unavailableReadMarker = await sendFixturePrint(pane, server, terminalId, "I07_UNAVAILABLE_READ_AFTER");
    await assertChangedAndNonBlank(page, pane, beforeRead);

    const transcript = await server.readTranscript(terminalId);
    const commandLines = transcript.filter((entry) => entry.event === "command");
    expect(commandLines.filter((entry) => entry.command_base64 === encodeBase64("PRINT I07_UNAVAILABLE_WRITE_AFTER I07_AFTER"))).toHaveLength(1);
    expect(commandLines.filter((entry) => entry.command_base64 === encodeBase64("PRINT I07_UNAVAILABLE_READ_AFTER I07_AFTER"))).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "error" && entry.operation === "command")).toHaveLength(0);

    await assertHealthyTerminal(page, pane, terminalId, [unavailableWriteMarker, unavailableReadMarker]);
  });
});
