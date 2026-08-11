import { expect, test, type TranscriptEntry } from "../fixtures/test.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConnected,
  expectTerminalSynchronized,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const CR = Buffer.from([0x0d]);
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

const bytes = (hex: string): Buffer => Buffer.from(hex, "hex");
const base64 = (value: Buffer | string): string => (
  Buffer.isBuffer(value) ? value.toString("base64") : Buffer.from(value, "ascii").toString("base64")
);

function entryString(entry: TranscriptEntry, field: string): string {
  const value = entry[field];
  if (typeof value !== "string") throw new Error(`transcript ${field} is not a string`);
  return value;
}
function expectCommandBytes(entry: TranscriptEntry, command: string): void {
  const recorded = Buffer.from(entryString(entry, "command_base64"), "base64");
  const accepted = Buffer.concat([recorded, CR]);
  expect(accepted.toString("hex")).toBe(Buffer.from(`${command}\r`, "ascii").toString("hex"));
}


function entryNumber(entry: TranscriptEntry, field: string): number {
  const value = entry[field];
  if (typeof value !== "number") throw new Error(`transcript ${field} is not a number`);
  return value;
}

function echoMarker(id: string, payload: Buffer): string {
  return `[E2E:ECHO_INPUT:${id}:${base64(payload)}]`;
}

function binaryInputFrames(
  events: readonly { readonly type: string; readonly direction?: string; readonly frame?: { readonly opcode: number } }[],
): number {
  return events.filter((event) => (
    event.type === "frame"
    && event.direction === "browser-to-server"
    && event.frame?.opcode === 2
  )).length;
}

test("@nightly @input @modifiers @mobile I-03 Modified Enter and mobile modifiers", async ({
  page,
  baseURL,
  server,
  faultController,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.createTerminal();

  const paneElement = page.locator("section[role=\"region\"][data-terminal-id]").first();
  await expect(paneElement).toBeVisible();
  const terminalId = await paneElement.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal has no stable terminal id");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalConnected(page, terminalId);
  await expectTerminalSynchronized(page, terminalId);
  await pane.focus();

  const readyId = "I03_RD";
  await pane.sendInput(`READY ${readyId}`, true);
  const readyCommand = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "READY"
    && entry.command_base64 === base64(`READY ${readyId}`)
  ));
  expectCommandBytes(readyCommand, `READY ${readyId}`);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:READY:${readyId}]`,
    occurrences: 1,
  });

  const desktopBefore = await screenshotRegion(page, pane.xtermHost);
  const echoIds: string[] = [];

  const armEcho = async (id: string): Promise<void> => {
    echoIds.push(id);
    await pane.sendInput(`ECHO_INPUT ${id}`, true);
    const echoCommand = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "command"
      && entry.operation === "ECHO_INPUT"
      && entry.command_base64 === base64(`ECHO_INPUT ${id}`)
    ));
    expectCommandBytes(echoCommand, `ECHO_INPUT ${id}`);
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "echo_input" && entry.id === id && entry.phase === "armed"
    ));
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:ECHO_INPUT:${id}:READY]`,
      occurrences: 1,
    });
  };

  const runEchoCase = async (options: {
    readonly id: string;
    readonly expected: Buffer;
    readonly action: () => Promise<void>;
    readonly binaryFrames: number;
  }): Promise<void> => {
    await armEcho(options.id);
    const frameStart = faultController.events.length;
    await options.action();
    const payload = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "echo_input" && entry.id === options.id && entry.phase === "payload"
    ));

    const payloadBytes = options.expected.subarray(0, options.expected.length - CR.length);
    expect(entryString(payload, "payload_base64")).toBe(base64(payloadBytes));
    expect(entryNumber(payload, "bytes")).toBe(payloadBytes.length);
    const reconstructed = Buffer.concat([Buffer.from(entryString(payload, "payload_base64"), "base64"), CR]);
    expect(reconstructed.toString("hex")).toBe(options.expected.toString("hex"));

    await expectTerminalBuffer(page, terminalId, {
      contains: echoMarker(options.id, payloadBytes),
      occurrences: 1,
    });
    const frames = binaryInputFrames(faultController.events.slice(frameStart));
    expect(frames, `unexpected binary input frame count for ${options.id}`).toBe(options.binaryFrames);

    const matchingPayloads = (await server.readTranscript(terminalId)).filter((entry) => (
      entry.event === "echo_input" && entry.id === options.id && entry.phase === "payload"
    ));
    expect(matchingPayloads).toHaveLength(1);
  };

  await runEchoCase({
    id: "I03_PE",
    expected: bytes("0d"),
    binaryFrames: 1,
    action: async () => pane.press("Enter"),
  });
  await runEchoCase({
    id: "I03_SE",
    expected: bytes("0d"),
    binaryFrames: 1,
    action: async () => pane.press("Shift+Enter"),
  });
  await runEchoCase({
    id: "I03_AE",
    expected: bytes("1b0d"),
    binaryFrames: 1,
    action: async () => pane.press("Alt+Enter"),
  });
  await runEchoCase({
    id: "I03_CE",
    expected: bytes("0d"),
    binaryFrames: 1,
    action: async () => pane.press("Control+Enter"),
  });
  await runEchoCase({
    id: "I03_ME",
    expected: bytes("0d"),
    binaryFrames: 1,
    action: async () => pane.press("Meta+Enter"),
  });
  await runEchoCase({
    id: "I03_CC",
    expected: bytes("030d"),
    binaryFrames: 2,
    action: async () => {
      await pane.press("Control+c");
      await pane.press("Enter");
    },
  });
  await runEchoCase({
    id: "I03_AX",
    expected: bytes("1b780d"),
    binaryFrames: 2,
    action: async () => {
      await pane.press("Alt+x");
      await pane.press("Enter");
    },
  });
  await runEchoCase({
    id: "I03_CB",
    expected: bytes("1b0d"),
    binaryFrames: 2,
    action: async () => {
      await pane.press("Control+[");
      await pane.press("Enter");
    },
  });
  await runEchoCase({
    id: "I03_CQ",
    expected: bytes("7f0d"),
    binaryFrames: 2,
    action: async () => {
      await pane.press("Control+Shift+/");
      await pane.press("Enter");
    },
  });
  const platform = await page.evaluate(() => navigator.platform);
  if (!/Mac|iPhone|iPad|iPod/i.test(platform)) {
    await pane.focus();
    const copyStart = faultController.events.length;
    await page.keyboard.press("Control+Shift+C");
    await pane.sendInput("PRINT I03_CP", true);
    const copyCommand = await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "command"
      && entry.operation === "PRINT"
      && entry.command_base64 === base64("PRINT I03_CP")
    ));
    expectCommandBytes(copyCommand, "PRINT I03_CP");
    await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === "I03_CP");
    await expectTerminalBuffer(page, terminalId, {
      contains: "[E2E:PRINT:I03_CP:I03_CP]",
      occurrences: 1,
    });
    expect(binaryInputFrames(faultController.events.slice(copyStart))).toBe(1);
  } else {
    test.info().annotations.push({
      type: "skip",
      description: `Linux Ctrl+Shift+C branch not applicable on ${platform}`,
    });
  }

  const desktopAfter = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(desktopBefore, desktopAfter, {
    minimumChangedRatio: 0.002,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
  });

  const beforeMobileResize = await pane.snapshot();
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.evaluate(async ({ id, beforeCols }) => {
    const api = window.__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForEvent(
      id,
      (event) => event.type === "viewport"
        && event.data.source === "proposed"
        && (beforeCols === undefined || event.data.cols !== beforeCols),
      { timeout: 10_000 },
    );
    await api.waitForTerminal(
      id,
      (snapshot) => {
        const desired = snapshot.desiredViewport;
        const server = snapshot.serverViewport;
        return desired !== undefined
          && server !== undefined
          && desired.cols === server.cols
          && desired.rows === server.rows
          && (beforeCols === undefined || desired.cols !== beforeCols);
      },
      { timeout: 10_000 },
    );
  }, { id: terminalId, beforeCols: beforeMobileResize?.cols });
  const keybar = pane.root.getByRole("navigation", {
    name: "Terminal keyboard shortcuts",
    exact: true,
  });
  await expect(keybar).toBeVisible();
  const mobileBefore = await screenshotRegion(page, pane.xtermHost);
  const ctrlButton = keybar.getByRole("button", { name: "Ctrl", exact: true });
  const altButton = keybar.getByRole("button", { name: "Alt", exact: true });
  const expectXtermFocus = async (): Promise<void> => {
    await expect(pane.xtermHost.locator(":focus")).toHaveCount(1);
  };

  await runEchoCase({
    id: "I03_MC",
    expected: bytes("030d"),
    binaryFrames: 2,
    action: async () => {
      await expect(ctrlButton).toHaveAttribute("aria-pressed", "false");
      await ctrlButton.click();
      await expect(ctrlButton).toHaveAttribute("aria-pressed", "true");
      await expectXtermFocus();
      await page.keyboard.press("c");
      await expect(ctrlButton).toHaveAttribute("aria-pressed", "false");
      await expectXtermFocus();
      await page.keyboard.press("Enter");
    },
  });
  await runEchoCase({
    id: "I03_MX",
    expected: bytes("1b780d"),
    binaryFrames: 2,
    action: async () => {
      await expect(altButton).toHaveAttribute("aria-pressed", "false");
      await altButton.click();
      await expect(altButton).toHaveAttribute("aria-pressed", "true");
      await expectXtermFocus();
      await page.keyboard.press("x");
      await expect(altButton).toHaveAttribute("aria-pressed", "false");
      await expectXtermFocus();
      await page.keyboard.press("Enter");
    },
  });
  await runEchoCase({
    id: "I03_ML",
    expected: bytes("1b5b313b37440d"),
    binaryFrames: 2,
    action: async () => {
      await expect(ctrlButton).toHaveAttribute("aria-pressed", "false");
      await expect(altButton).toHaveAttribute("aria-pressed", "false");
      await ctrlButton.click();
      await expect(ctrlButton).toHaveAttribute("aria-pressed", "true");
      await expectXtermFocus();
      await altButton.click();
      await expect(altButton).toHaveAttribute("aria-pressed", "true");
      await expectXtermFocus();
      await keybar.getByRole("button", { name: "Left arrow", exact: true }).click();
      await expect(ctrlButton).toHaveAttribute("aria-pressed", "false");
      await expect(altButton).toHaveAttribute("aria-pressed", "false");
      await expectXtermFocus();
      await page.keyboard.press("Enter");
    },
  });
  await runEchoCase({
    id: "I03_MS",
    expected: bytes("1b0d"),
    binaryFrames: 2,
    action: async () => {
      await keybar.getByRole("button", { name: "Esc", exact: true }).click();
      await expect(ctrlButton).toHaveAttribute("aria-pressed", "false");
      await expect(altButton).toHaveAttribute("aria-pressed", "false");
      await expectXtermFocus();
      await page.keyboard.press("Enter");
    },
  });
  await runEchoCase({
    id: "I03_MT",
    expected: bytes("090d"),
    binaryFrames: 2,
    action: async () => {
      await keybar.getByRole("button", { name: "Tab", exact: true }).click();
      await expect(ctrlButton).toHaveAttribute("aria-pressed", "false");
      await expect(altButton).toHaveAttribute("aria-pressed", "false");
      await expectXtermFocus();
      await page.keyboard.press("Enter");
    },
  });
  await pane.sendInput("PRINT I03_CONT", true);


  const continuedCommand = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "PRINT"
    && entry.command_base64 === base64("PRINT I03_CONT")
  ));
  expectCommandBytes(continuedCommand, "PRINT I03_CONT");
  await expectTerminalBuffer(page, terminalId, {
    contains: "[E2E:PRINT:I03_CONT:I03_CONT]",
    occurrences: 1,
  });
  const dimensionSnapshot = await pane.snapshot();
  if (!dimensionSnapshot) throw new Error("missing diagnostics snapshot before PTY size assertion");
  const sizeId = "I03_SZ";
  await pane.sendInput(`SIZE ${sizeId}`, true);
  const sizeCommand = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === "SIZE"
    && entry.command_base64 === base64(`SIZE ${sizeId}`)
  ));
  expectCommandBytes(sizeCommand, `SIZE ${sizeId}`);
  const sizeRecord = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "size" && entry.id === sizeId
  ));
  expect(entryNumber(sizeRecord, "rows")).toBe(dimensionSnapshot.rows);
  expect(entryNumber(sizeRecord, "cols")).toBe(dimensionSnapshot.cols);
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:SIZE:${sizeId}:`,
  });
  const mobileAfter = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(mobileBefore, mobileAfter, {
    minimumChangedRatio: 0.002,
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
  });

  const transcript = await server.readTranscript(terminalId);
  const payloadIds = transcript
    .filter((entry) => entry.event === "echo_input" && entry.phase === "payload")
    .map((entry) => entry.id);
  expect(payloadIds).toEqual(echoIds);

  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId);
  await assertMonotonicSequences(invariantReport.events);
  expect(invariantReport.snapshot.activeSocketCount).toBe(1);
  expect(invariantReport.snapshot.activeBuffer).toBe("normal");
  expect(invariantReport.snapshot.acceptingInput).toBe(true);
  expect(invariantReport.snapshot.pendingParserWrites).toBe(0);
  expect(invariantReport.snapshot.pendingParserBytes).toBe(0);
  expect(invariantReport.snapshot.renderBacklogBytes).toBe(0);
  expect(invariantReport.snapshot.renderBacklogFrames).toBe(0);
  expect(invariantReport.snapshot.flow.pendingAcknowledgementBytes).toBe(0);
  expect(invariantReport.snapshot.serverViewport).toBeDefined();
  expect(invariantReport.snapshot.serverViewport?.cols).toBe(invariantReport.snapshot.cols);
  expect(invariantReport.snapshot.serverViewport?.rows).toBe(invariantReport.snapshot.rows);
  expect(invariantReport.snapshot.viewport.cols).toBe(invariantReport.snapshot.cols);
  expect(invariantReport.snapshot.viewport.rows).toBe(invariantReport.snapshot.rows);
  expect(invariantReport.snapshot.desiredViewport?.cols).toBe(invariantReport.snapshot.cols);
  expect(invariantReport.snapshot.desiredViewport?.rows).toBe(invariantReport.snapshot.rows);
  expect(invariantReport.snapshot.sentViewport?.cols).toBe(invariantReport.snapshot.cols);
  expect(invariantReport.snapshot.sentViewport?.rows).toBe(invariantReport.snapshot.rows);
  expect(invariantReport.snapshot.receivedSequence).toBeDefined();
  expect(invariantReport.snapshot.committedSequence).toBe(invariantReport.snapshot.receivedSequence);
  expect(invariantReport.events.filter((event) => event.type === "error")).toEqual([]);
  expect(faultController.events.filter((event) => event.type === "socket-error" || event.type === "malformed-frame")).toEqual([]);
  expect(browserErrors).toEqual([]);
});
