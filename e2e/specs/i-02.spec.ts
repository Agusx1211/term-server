import { test, expect } from "../fixtures/test.js";
import type { IsolatedServer } from "../fixtures/test.js";
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
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";
import type { NetworkFaultController } from "../fixtures/network-faults.js";

const BRACKETED_PASTE_BEGIN = Buffer.from("\x1b[200~", "binary");
const BRACKETED_PASTE_END = Buffer.from("\x1b[201~", "binary");
const MULTILINE_PASTE = "line-a\nline-b";
const LARGE_PASTE = "A".repeat(20_000);
const UTF8_PASTE = "prefix-猫-suffix";
const INPUT_CHUNK_BYTES = 16 * 1024;

const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

const CLIPBOARD_PERMISSION_NOTICE = "Clipboard permission was denied";
const CLIPBOARD_CONTEXT_NOTICE = "Clipboard access requires HTTPS or localhost";

type E2EWindow = Window & { __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi };

type PasteRoute = "menu" | "native";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function commandBytes(command: string): string {
  return base64(Buffer.from(command, "utf8"));
}

function expectedPaste(text: string, bracketed: boolean): Buffer {
  const payload = Buffer.from(text, "utf8");
  return bracketed
    ? Buffer.concat([BRACKETED_PASTE_BEGIN, payload, BRACKETED_PASTE_END])
    : payload;
}

function websocketFrameSizes(payloadBytes: number): number[] {
  const chunkSizes: number[] = [];
  for (let offset = 0; offset < payloadBytes; offset += INPUT_CHUNK_BYTES) {
    chunkSizes.push(Math.min(INPUT_CHUNK_BYTES, payloadBytes - offset));
  }
  return chunkSizes.map((size) => size + (size <= 125 ? 6 : size <= 65_535 ? 8 : 14));
}

async function waitForCommand(
  server: IsolatedServer,
  terminalId: string,
  command: string,
): Promise<void> {
  const operation = command.split(/\s+/, 1)[0];
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
    && entry.operation === operation
    && entry.command_base64 === commandBytes(command)
  ));
}

async function waitForOutputBarrier(
  page: Parameters<typeof expectTerminalConnected>[0],
  terminalId: string,
  previousReceivedSequence: number | undefined,
): Promise<void> {
  await page.evaluate(async ({ id, previous }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(
      id,
      (snapshot) => (
        (snapshot.receivedSequence ?? -1) > (previous ?? -1)
        && snapshot.pendingParserWrites === 0
      ),
      { timeout: 15_000 },
    );
  }, { id: terminalId, previous: previousReceivedSequence });
}

async function waitForSettled(
  page: Parameters<typeof expectTerminalConnected>[0],
  terminalId: string,
): Promise<void> {
  await page.evaluate(async (id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(
      id,
      (snapshot) => (
        snapshot.socketState === "connected"
        && snapshot.activeSocketCount === 1
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
        && snapshot.syncMode === undefined
      ),
      { timeout: 15_000 },
    );
  }, terminalId);
}

async function issueCommand(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  command: string,
): Promise<void> {
  await pane.sendInput(command, true);
  await waitForCommand(server, terminalId, command);
}

async function printMarker(
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  marker: string,
): Promise<void> {
  const command = `PRINT ${marker} marker`;
  await issueCommand(pane, server, terminalId, command);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === marker
  ));
  await expectTerminalBuffer(pane.page, terminalId, { contains: marker, occurrences: 1 });
}

async function paste(
  pane: TerminalPanePage,
  route: PasteRoute,
  nativeShortcut: string,
): Promise<void> {
  if (route === "menu") {
    await pane.openActions();
    await pane.root.getByRole("menuitem", { name: "Paste", exact: true }).click();
    return;
  }
  await pane.focus();
  await pane.page.keyboard.press(nativeShortcut);
}

function binaryFramesSince(
  controller: NetworkFaultController,
  startIndex: number,
  terminalId: string,
): readonly number[] {
  return controller.events.slice(startIndex)
    .filter((event) => (
      event.type === "frame"
      && event.direction === "browser-to-server"
      && event.terminalId === terminalId
      && event.frame?.opcode === 2
    ))
    .map((event) => event.frame?.bytes ?? 0);
}

async function capturePaste(
  pane: TerminalPanePage,
  server: IsolatedServer,
  faultController: NetworkFaultController,
  terminalId: string,
  captureId: string,
  text: string,
  bracketed: boolean,
  route: PasteRoute,
  nativeShortcut: string,
): Promise<void> {
  const expected = expectedPaste(text, bracketed);
  await issueCommand(
    pane,
    server,
    terminalId,
    `CAPTURE_INPUT ${captureId} ${expected.byteLength}`,
  );
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "capture_input"
    && entry.phase === "armed"
    && entry.id === captureId
    && entry.bytes === expected.byteLength
  ));

  const frameStart = faultController.events.length;
  await paste(pane, route, nativeShortcut);
  const complete = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "capture_input"
    && entry.phase === "complete"
    && entry.id === captureId
    && entry.bytes === expected.byteLength
  ));
  if (typeof complete.payload_base64 !== "string") {
    throw new Error(`capture ${captureId} did not include its exact payload`);
  }
  expect([...Buffer.from(complete.payload_base64, "base64")]).toEqual([...expected]);

  const frameSizes = binaryFramesSince(faultController, frameStart, terminalId);
  expect(frameSizes).toEqual(websocketFrameSizes(expected.byteLength));
  expect(frameSizes.every((size) => size <= INPUT_CHUNK_BYTES + 8)).toBe(true);
}

async function setClipboard(page: Parameters<typeof expectTerminalConnected>[0], text: string): Promise<void> {
  await page.evaluate(async (value) => {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard write API is unavailable");
    await navigator.clipboard.writeText(value);
  }, text);
}

async function terminalIdFromMountedPane(page: Parameters<typeof expectTerminalConnected>[0]): Promise<string> {
  const terminal = page.locator(".editor-grid [data-terminal-id]").first();
  await expect(terminal).toBeVisible();
  const terminalId = await terminal.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal did not expose a stable terminal ID");
  return terminalId;
}

test("I-02 Bracketed paste enabled and disabled @nightly @input @clipboard @paste", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(baseURL);
  await page.setViewportSize(MOBILE_VIEWPORT);
  const origin = new URL(baseURL).origin;
  const clipboardAvailable = await page.evaluate(() => (
    typeof navigator.clipboard?.readText === "function"
    && typeof navigator.clipboard?.writeText === "function"
  ));

  const login = new LoginPage(page);
  await login.login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();
  const terminalId = await terminalIdFromMountedPane(page);
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const initial = await expectTerminalSynchronized(page, terminalId);
  await expectTerminalConnected(page, terminalId);
  await expectSingleTerminalSocket(page, terminalId);
  expect(initial.acceptingInput).toBe(true);
  expect(initial.serverViewport?.cols ?? initial.cols).toBeGreaterThan(0);
  expect(initial.serverViewport?.rows ?? initial.rows).toBeGreaterThan(0);

  await issueCommand(pane, server, terminalId, `READY I02_READY`);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === "I02_READY");
  await waitForOutputBarrier(page, terminalId, initial.receivedSequence);
  const beforePaste = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "i-02-ready-crop",
  });

  const nativeShortcut = /Mac|iPhone|iPad|iPod/i.test(await page.evaluate(() => navigator.platform))
    ? "Meta+V"
    : "Control+Shift+V";

  await page.context().clearPermissions();
  const frameStartBeforeDenied = faultController.events.length;
  await pane.openActions();
  await pane.root.getByRole("menuitem", { name: "Paste", exact: true }).click();
  const deniedNotice = clipboardAvailable ? CLIPBOARD_PERMISSION_NOTICE : CLIPBOARD_CONTEXT_NOTICE;
  await expect(page.getByText(deniedNotice, { exact: true })).toBeVisible();
  expect(binaryFramesSince(faultController, frameStartBeforeDenied, terminalId)).toEqual([]);
  await printMarker(pane, server, terminalId, "I02_DENIED_AFTER");

  if (clipboardAvailable) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });

    const beforeEnable = await pane.snapshot();
    await issueCommand(pane, server, terminalId, "BYTES I02_ENABLE 1b5b3f3230303468");
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "bytes"
      && entry.id === "I02_ENABLE"
      && entry.payload_base64 === base64(Buffer.from("\x1b[?2004h", "binary"))
    ));
    await waitForOutputBarrier(page, terminalId, beforeEnable?.receivedSequence);

    const enabledSmall = expectedPaste(MULTILINE_PASTE, true);
    await setClipboard(page, MULTILINE_PASTE);
    await capturePaste(
      pane,
      server,
      faultController,
      terminalId,
      "I02_ENABLED_MENU",
      MULTILINE_PASTE,
      true,
      "menu",
      nativeShortcut,
    );
    expect(enabledSmall.byteLength).toBe(Buffer.byteLength(MULTILINE_PASTE) + BRACKETED_PASTE_BEGIN.length + BRACKETED_PASTE_END.length);
    await printMarker(pane, server, terminalId, "I02_ENABLED_MENU_AFTER");

    await setClipboard(page, LARGE_PASTE);
    await capturePaste(
      pane,
      server,
      faultController,
      terminalId,
      "I02_ENABLED_NATIVE_LARGE",
      LARGE_PASTE,
      true,
      "native",
      nativeShortcut,
    );
    await printMarker(pane, server, terminalId, "I02_ENABLED_LARGE_AFTER");

    const beforeDisable = await pane.snapshot();
    await issueCommand(pane, server, terminalId, "BYTES I02_DISABLE 1b5b3f323030346c");
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "bytes"
      && entry.id === "I02_DISABLE"
      && entry.payload_base64 === base64(Buffer.from("\x1b[?2004l", "binary"))
    ));
    await waitForOutputBarrier(page, terminalId, beforeDisable?.receivedSequence);

    await setClipboard(page, MULTILINE_PASTE);
    await capturePaste(
      pane,
      server,
      faultController,
      terminalId,
      "I02_DISABLED_MENU",
      MULTILINE_PASTE,
      false,
      "menu",
      nativeShortcut,
    );
    await printMarker(pane, server, terminalId, "I02_DISABLED_MENU_AFTER");

    await setClipboard(page, LARGE_PASTE);
    await capturePaste(
      pane,
      server,
      faultController,
      terminalId,
      "I02_DISABLED_NATIVE_LARGE",
      LARGE_PASTE,
      false,
      "native",
      nativeShortcut,
    );
    await printMarker(pane, server, terminalId, "I02_DISABLED_LARGE_AFTER");

    await setClipboard(page, UTF8_PASTE);
    await capturePaste(
      pane,
      server,
      faultController,
      terminalId,
      "I02_DISABLED_UTF8",
      UTF8_PASTE,
      false,
      "menu",
      nativeShortcut,
    );
    await printMarker(pane, server, terminalId, "I02_UTF8_AFTER");
  }

  await waitForSettled(page, terminalId);
  const final = await pane.snapshot();
  if (!final) throw new Error("missing final I-02 terminal diagnostics snapshot");
  await expectNoPendingRecovery(page, terminalId);
  await expectTerminalConnected(page, terminalId);
  await expectSingleTerminalSocket(page, terminalId);
  expect(final.socketState).toBe("connected");
  expect(final.activeSocketCount).toBe(1);
  expect(final.syncMode).toBeUndefined();
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  expect(final.receivedSequence).toBe(final.committedSequence);
  expect(final.serverViewport?.cols ?? final.cols).toBe(initial.serverViewport?.cols ?? initial.cols);
  expect(final.serverViewport?.rows ?? final.rows).toBe(initial.serverViewport?.rows ?? initial.rows);
  await expectTerminalBuffer(page, terminalId, { contains: "I02_DENIED_AFTER", occurrences: 1 });
  if (clipboardAvailable) {
    await expectTerminalBuffer(page, terminalId, { contains: "I02_ENABLED_MENU_AFTER", occurrences: 1 });
    await expectTerminalBuffer(page, terminalId, { contains: "I02_ENABLED_LARGE_AFTER", occurrences: 1 });
    await expectTerminalBuffer(page, terminalId, { contains: "I02_DISABLED_MENU_AFTER", occurrences: 1 });
    await expectTerminalBuffer(page, terminalId, { contains: "I02_DISABLED_LARGE_AFTER", occurrences: 1 });
    await expectTerminalBuffer(page, terminalId, { contains: "I02_UTF8_AFTER", occurrences: 1 });
  }
  const afterPaste = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforePaste, afterPaste, {
    testInfo,
    artifactName: "i-02-after-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "i-02-final-crop",
  });

  await issueCommand(pane, server, terminalId, "SIZE I02_SIZE");
  const size = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === "I02_SIZE");
  expect(size.rows).toBe(final.serverViewport?.rows ?? final.rows);
  expect(size.cols).toBe(final.serverViewport?.cols ?? final.cols);

  const events = await pane.events();
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(browserErrors).toEqual([]);
  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "capture_input" && entry.phase === "complete").length).toBe(
    clipboardAvailable ? 5 : 0,
  );
  expect(server.stderr).not.toMatch(/panic|fatal/i);
});
