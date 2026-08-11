import { expect, test } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import type { E2ETerminalDiagnosticsApi, E2ETerminalSnapshot } from "../../src/client/lib/e2e-diagnostics.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
} from "../assertions/terminal-state.js";
import {
  changedPixelRatio,
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 30_000;
const MOBILE_VIEWPORT = { width: 390, height: 844 };

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TranscriptEntry = Record<string, unknown>;

function commandInputBytes(command: string): Buffer {
  return Buffer.from(`${command}\r`, "utf8");
}

/**
 * The fixture's command record stores the line after its parser consumed the
 * CR. Re-attach that delimiter before comparing against the exact PTY input
 * oracle, so a test cannot accidentally accept LF-normalized input.
 */
function commandRecordMatches(entry: TranscriptEntry, command: string): boolean {
  if (entry.event !== "command" || typeof entry.command_base64 !== "string") return false;
  const recorded = Buffer.from(entry.command_base64, "base64");
  return Buffer.concat([recorded, Buffer.from("\r")]).equals(commandInputBytes(command));
}

function commandCount(entries: readonly TranscriptEntry[], command: string): number {
  return entries.filter((entry) => commandRecordMatches(entry, command)).length;
}

async function waitForSocketSnapshot(
  page: Page,
  terminalId: string,
  options: {
    readonly generationGreaterThan?: number;
    readonly generationEquals?: number;
    readonly states?: readonly E2ETerminalSnapshot["socketState"][];
    readonly acceptingInput?: boolean;
    readonly timeout?: number;
  },
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, generationGreaterThan, generationEquals, states, acceptingInput, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      (generationGreaterThan === undefined || snapshot.socketGeneration > generationGreaterThan)
      && (generationEquals === undefined || snapshot.socketGeneration === generationEquals)
      && (states === undefined || states.includes(snapshot.socketState))
      && (acceptingInput === undefined || snapshot.acceptingInput === acceptingInput)
    ), { timeout });
  }, { id: terminalId, ...options });
}

async function clickMobileInputKeys(pane: TerminalPanePage): Promise<void> {
  const keybar = pane.root.getByRole("navigation", { name: "Terminal keyboard shortcuts", exact: true });
  await expect(keybar).toBeVisible();
  await keybar.getByRole("button", { name: "Esc", exact: true }).click();
  await keybar.getByRole("button", { name: "Tab", exact: true }).click();
}

test("I-08 Input during connecting and recovering @pr @input @connecting @recovery @nightly", async ({ page, server, faultController }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  // This is a transport fault, not a timing sleep: the upgrade remains
  // CONNECTING while the pre-acceptance input assertions execute.
  faultController.delayUpgrade(undefined, 5_000);

  await page.goto("/");
  await new LoginPage(page).login();
  await page.setViewportSize(MOBILE_VIEWPORT);

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const terminalRegion = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(terminalRegion).toBeVisible();
  const terminalId = await terminalRegion.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("new terminal did not expose a stable terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await pane.waitForEvent("socket-created", { timeout: WAIT_TIMEOUT_MS });

  const connecting = await pane.snapshot();
  if (!connecting) throw new Error(`missing connecting diagnostics for terminal ${terminalId}`);
  expect(connecting.socketState).toBe("connecting");
  expect(connecting.acceptingInput).toBe(false);
  expect(connecting.activeSocketCount).toBe(1);
  await pane.focus();
  const connectingCrop = await screenshotRegion(page, pane.xtermHost);

  const connectingCommand = "ECHO_INPUT I08_CONNECTING";
  await pane.sendInput(connectingCommand, true);
  await clickMobileInputKeys(pane);

  const afterConnectingInput = await pane.snapshot();
  if (!afterConnectingInput) throw new Error(`missing post-input diagnostics for terminal ${terminalId}`);
  expect(afterConnectingInput.acceptingInput).toBe(false);
  expect(afterConnectingInput.xterm.text).not.toContain("I08_CONNECTING");
  const connectingEntries = await server.readTranscript(terminalId);
  expect(commandCount(connectingEntries, connectingCommand)).toBe(0);
  expect(changedPixelRatio(connectingCrop, await screenshotRegion(page, pane.xtermHost))).toBeLessThan(0.002);

  const synced = await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });
  expect(synced.acceptingInput).toBe(true);
  expect(synced.socketState).toBe("connected");

  const readyCommand = "READY I08";
  await pane.sendInput(readyCommand, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === "I08", { timeoutMs: WAIT_TIMEOUT_MS });

  const readySnapshot = await pane.snapshot();
  if (!readySnapshot) throw new Error(`missing ready diagnostics for terminal ${terminalId}`);
  const initialGeneration = readySnapshot.socketGeneration;
  expect(initialGeneration).toBeGreaterThan(0);

  // Hold the fixture's PRINT output at the proxy. Closing this generation
  // forces the recovery stream to replay it after the new socket synchronizes.
  const pausedOutput = faultController.pause("server-to-browser", {
    terminalId,
    generation: initialGeneration,
  });
  await faultController.waitFor((event) => (
    event.type === "paused"
    && event.terminalId === terminalId
    && event.generation === initialGeneration
    && event.direction === "server-to-browser"
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  const disconnectedPrint = "PRINT I08_DISCONNECTED HELD";
  await pane.sendInput(disconnectedPrint, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === "I08_DISCONNECTED", { timeoutMs: WAIT_TIMEOUT_MS });

  await page.evaluate(({ id, generation }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.close(id, { generation, abrupt: true });
  }, { id: terminalId, generation: initialGeneration });

  await waitForSocketSnapshot(page, terminalId, {
    generationEquals: initialGeneration,
    states: ["closed", "disconnected"],
    acceptingInput: false,
    timeout: WAIT_TIMEOUT_MS,
  });
  const reconnecting = await waitForSocketSnapshot(page, terminalId, {
    generationGreaterThan: initialGeneration,
    states: ["connecting", "recovering"],
    acceptingInput: false,
    timeout: WAIT_TIMEOUT_MS,
  });
  expect(reconnecting.socketGeneration).toBeGreaterThan(initialGeneration);

  const recoveryCommand = "ECHO_INPUT I08_RECOVERING";
  const recoveryBefore = await pane.snapshot();
  if (!recoveryBefore) throw new Error(`missing recovery diagnostics for terminal ${terminalId}`);
  const recoveryText = recoveryBefore.xterm.text;
  const recoveryCrop = await screenshotRegion(page, pane.xtermHost);
  await pane.sendInput(recoveryCommand, true);
  // Repeating the fixture command during recovery is deliberately attempted;
  // the policy is disabled input, so it must not duplicate the held marker.
  await pane.sendInput(disconnectedPrint, true);
  await clickMobileInputKeys(pane);

  const afterRecoveryInput = await pane.snapshot();
  if (!afterRecoveryInput) throw new Error(`missing post-recovery-input diagnostics for terminal ${terminalId}`);
  expect(afterRecoveryInput.acceptingInput).toBe(false);
  expect(afterRecoveryInput.xterm.text).toBe(recoveryText);
  expect(changedPixelRatio(recoveryCrop, await screenshotRegion(page, pane.xtermHost))).toBeLessThan(0.002);
  const recoveryEntries = await server.readTranscript(terminalId);
  expect(commandCount(recoveryEntries, recoveryCommand)).toBe(0);
  expect(commandCount(recoveryEntries, disconnectedPrint)).toBe(1);

  pausedOutput.dispose();
  const recovered = await waitForSocketSnapshot(page, terminalId, {
    generationGreaterThan: initialGeneration,
    states: ["connected"],
    acceptingInput: true,
    timeout: WAIT_TIMEOUT_MS,
  });
  expect(recovered.socketGeneration).toBeGreaterThan(initialGeneration);
  expect(recovered.syncMode).toBeUndefined();
  expect(recovered.activeSocketCount).toBe(1);

  const afterCommand = "ECHO_INPUT I08_AFTER";
  const afterPayload = "I08_AFTER_ACCEPTED";
  const afterPayloadBase64 = Buffer.from(afterPayload, "utf8").toString("base64");
  await pane.sendInput(afterCommand, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === "I08_AFTER" && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await server.waitForTranscript(terminalId, (entry) => entry.event === "write" && typeof entry.data_base64 === "string" && entry.text === "[E2E:ECHO_INPUT:I08_AFTER:READY]\n", { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: "[E2E:ECHO_INPUT:I08_AFTER:READY]" }, { timeout: WAIT_TIMEOUT_MS });
  await pane.sendInput(afterPayload, true);
  const afterPayloadEntry = await server.waitForTranscript<{ event: string; id: string; phase: string; bytes: number; payload_base64: string }>(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === "I08_AFTER"
      && entry.phase === "payload"
      && entry.payload_base64 === afterPayloadBase64,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(afterPayloadEntry.bytes).toBe(Buffer.byteLength(afterPayload, "utf8"));
  expect(afterPayloadEntry.payload_base64).toBe(afterPayloadBase64);
  const afterPayloadMarker = `[E2E:ECHO_INPUT:I08_AFTER:${afterPayloadBase64}]`;
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "write"
      && typeof entry.data_base64 === "string"
      && entry.text === `${afterPayloadMarker}\n`,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, { contains: afterPayloadMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });

  await expectKnownMarkerChanged(page, pane.xtermHost, connectingCrop, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "i08-final-terminal-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "i08-final-terminal-nonblank",
  });
  const finalSnapshot = await pane.snapshot();
  if (!finalSnapshot) throw new Error(`missing final diagnostics for terminal ${terminalId}`);
  const normalizedFinalText = finalSnapshot.xterm.text.replaceAll("\n", "").replaceAll("\r", "");
  expect(normalizedFinalText).toContain("[E2E:PRINT:I08_DISCONNECTED:HELD]");
  expect(normalizedFinalText).toContain("[E2E:ECHO_INPUT:I08_AFTER:READY]");

  const sizeCommand = "SIZE I08";
  await pane.sendInput(sizeCommand, true);
  const sizeEntry = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === "I08", { timeoutMs: WAIT_TIMEOUT_MS });
  const rows = Number(sizeEntry.rows);
  const cols = Number(sizeEntry.cols);
  expect(Number.isInteger(rows)).toBe(true);
  expect(Number.isInteger(cols)).toBe(true);
  expect(rows).toBe(finalSnapshot.rows);
  expect(cols).toBe(finalSnapshot.cols);
  expect(finalSnapshot.serverViewport?.rows).toBe(rows);
  expect(finalSnapshot.serverViewport?.cols).toBe(cols);

  const entries = await server.readTranscript(terminalId);
  expect(commandCount(entries, readyCommand)).toBe(1);
  expect(commandCount(entries, connectingCommand)).toBe(0);
  expect(commandCount(entries, recoveryCommand)).toBe(0);
  expect(commandCount(entries, disconnectedPrint)).toBe(1);
  expect(commandCount(entries, afterCommand)).toBe(1);
  expect(commandCount(entries, sizeCommand)).toBe(1);
  expect(entries.filter((entry) => entry.event === "error")).toEqual([]);
  expect(entries.some((entry) => entry.event === "exit")).toBe(false);
  expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);

  const events = await pane.events();
  await assertMonotonicSequences(events);
  expect(events.some((event) => event.type === "socket-stale")).toBe(false);
  expect(events.some((event) => event.type === "error")).toBe(false);
  expect(events.some((event) => ["disconnected", "recovering", "connecting"].includes(event.snapshot.socketState))).toBe(true);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.acceptingInput).toBe(true);
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.syncMode).toBeUndefined();
  expect(finalSnapshot.pendingParserWrites).toBe(0);
  expect(finalSnapshot.pendingParserBytes).toBe(0);
  expect(finalSnapshot.renderBacklogBytes).toBe(0);
  expect(finalSnapshot.renderBacklogFrames).toBe(0);
  expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(browserErrors).toEqual([]);
});
