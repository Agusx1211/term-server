import { expect, test } from "../fixtures/test.js";
import type { TranscriptEntry } from "../fixtures/test.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectActiveBuffer,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalConnected,
  expectTerminalConverged,
  expectTerminalSynchronized,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";

const E2E_TIMEOUT = 30_000;
const encoder = new TextEncoder();

type TerminalEventType = "parser-commit" | "socket-close" | "synced";
type KittyAction = "SET" | "PUSH" | "POP" | "QUERY" | "RESET";

type ServerFixture = {
  readTranscript<T extends TranscriptEntry = TranscriptEntry>(id: string): Promise<T[]>;
  waitForTranscript<T extends TranscriptEntry = TranscriptEntry>(
    id: string,
    predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<T>;
};

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function sequenceFor(action: KittyAction, value?: number): string {
  switch (action) {
    case "SET":
      if (value === undefined) throw new Error("Kitty SET requires a value");
      return `\u001b[=${value}u`;
    case "PUSH":
      if (value === undefined) throw new Error("Kitty PUSH requires a value");
      return `\u001b[>${value}u`;
    case "POP":
      if (value === undefined) throw new Error("Kitty POP requires a value");
      return `\u001b[<${value}u`;
    case "QUERY":
      return "\u001b[?u";
    case "RESET":
      return "\u001b[=0u";
  }
}

function latestSequence(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((latest, entry) => {
    const sequence = entry.sequence;
    return typeof sequence === "number" && sequence > latest ? sequence : latest;
  }, 0);
}

function stringField(entry: TranscriptEntry, field: string): string | undefined {
  const value = entry[field];
  return typeof value === "string" ? value : undefined;
}

function numberField(entry: TranscriptEntry, field: string): number | undefined {
  const value = entry[field];
  return typeof value === "number" ? value : undefined;
}

async function latestEventId(pane: TerminalPanePage): Promise<number> {
  const events = await pane.events();
  return events.reduce((latest, event) => Math.max(latest, event.id), -1);
}

async function waitForEventAfter(
  page: import("@playwright/test").Page,
  terminalId: string,
  afterId: number,
  type: TerminalEventType,
): Promise<number> {
  return page.evaluate(async ({ id, after, eventType }) => {
    const api = window.__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const event = await api.waitForEvent(
      id,
      (candidate) => candidate.id > after && candidate.type === eventType,
      { timeout: 30_000 },
    );
    return event.id;
  }, { id: terminalId, after: afterId, eventType: type });
}

async function latestSnapshot(page: import("@playwright/test").Page, terminalId: string) {
  return page.evaluate((id) => {
    const api = window.__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const snapshot = api.terminal(id);
    if (!snapshot) throw new Error(`No E2E diagnostics for terminal ${id}`);
    return snapshot;
  }, terminalId);
}

async function waitForMarker(
  page: import("@playwright/test").Page,
  terminalId: string,
  marker: string,
): Promise<void> {
  await page.evaluate(async ({ id, expected }) => {
    const api = window.__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForTerminal(
      id,
      (snapshot) => snapshot.xterm.text.replace(/\r?\n/g, "").includes(expected),
      { timeout: 30_000 },
    );
  }, { id: terminalId, expected: marker });
}

async function waitForFocused(pane: TerminalPanePage): Promise<void> {
  await expect(pane.xtermHost.locator(".xterm-helper-textarea")).toBeFocused({
    timeout: E2E_TIMEOUT,
  });
}

async function sendFixtureCommand(pane: TerminalPanePage, input: string): Promise<void> {
  // Fixture control lines must bypass Kitty's per-key encoding. The command
  // channel is test setup; actual key captures below still exercise Kitty.
  await pane.insertText(input);
  await pane.press("Enter");
}

async function command(
  page: import("@playwright/test").Page,
  pane: TerminalPanePage,
  terminalId: string,
  server: ServerFixture,
  input: string,
  operation: string,
): Promise<TranscriptEntry> {
  const beforeEntries = await server.readTranscript(terminalId);
  const beforeSequence = latestSequence(beforeEntries);
  const beforeEvent = await latestEventId(pane);
  await sendFixtureCommand(pane, input);
  const commandEntry = await server.waitForTranscript(
    terminalId,
    (entry) => (
      typeof entry.sequence === "number"
      && entry.sequence > beforeSequence
      && entry.event === "command"
      && entry.operation === operation
      && stringField(entry, "command_base64") === base64(input)
    ),
    { timeoutMs: E2E_TIMEOUT },
  );
  await waitForEventAfter(page, terminalId, beforeEvent, "parser-commit");
  return commandEntry;
}

async function kittyCommand(
  page: import("@playwright/test").Page,
  pane: TerminalPanePage,
  terminalId: string,
  server: ServerFixture,
  action: KittyAction,
  value?: number,
): Promise<TranscriptEntry> {
  const suffix = value === undefined ? action : `${action} ${value}`;
  const input = `KITTY I04 ${suffix}`;
  const commandEntry = await command(page, pane, terminalId, server, input, "KITTY");
  const commandSequence = numberField(commandEntry, "sequence") ?? 0;
  const kittyEntry = await server.waitForTranscript(
    terminalId,
    (entry) => (
      typeof entry.sequence === "number"
      && entry.sequence > commandSequence
      && entry.event === "kitty"
      && entry.id === "I04"
      && entry.action === action.toLowerCase()
      && stringField(entry, "sequence_base64") === base64(sequenceFor(action, value))
    ),
    { timeoutMs: E2E_TIMEOUT },
  );
  if (value !== undefined) expect(kittyEntry.value).toBe(value);
  return kittyEntry;
}

async function captureInput(
  page: import("@playwright/test").Page,
  pane: TerminalPanePage,
  terminalId: string,
  server: ServerFixture,
  id: string,
  expected: string,
  action: () => Promise<void>,
): Promise<TranscriptEntry> {
  const beforeEntries = await server.readTranscript(terminalId);
  const beforeSequence = latestSequence(beforeEntries);
  const beforeEvent = await latestEventId(pane);
  await sendFixtureCommand(pane, `CAPTURE_INPUT ${id} ${encoder.encode(expected).byteLength}`);
  const armed = await server.waitForTranscript(
    terminalId,
    (entry) => (
      typeof entry.sequence === "number"
      && entry.sequence > beforeSequence
      && entry.event === "capture_input"
      && entry.phase === "armed"
      && entry.id === id
    ),
    { timeoutMs: E2E_TIMEOUT },
  );
  await waitForEventAfter(page, terminalId, beforeEvent, "parser-commit");
  await action();
  const armedSequence = numberField(armed, "sequence") ?? beforeSequence;
  const complete = await server.waitForTranscript(
    terminalId,
    (entry) => (
      typeof entry.sequence === "number"
      && entry.sequence > armedSequence
      && entry.event === "capture_input"
      && entry.phase === "complete"
      && entry.id === id
    ),
    { timeoutMs: E2E_TIMEOUT },
  );
  expect(numberField(complete, "bytes")).toBe(encoder.encode(expected).byteLength);
  expect(stringField(complete, "payload_base64")).toBe(base64(expected));
  return complete;
}

async function expectKittyQueryReply(
  server: ServerFixture,
  terminalId: string,
  queryEntry: TranscriptEntry,
  expectedFlags: number,
): Promise<void> {
  const expectedReply = `\u001b[?${expectedFlags}u`;
  const expectedPayload = base64(expectedReply);
  const querySequence = numberField(queryEntry, "sequence") ?? 0;
  const reply = await server.waitForTranscript(
    terminalId,
    (entry) => (
      typeof entry.sequence === "number"
      && entry.sequence > querySequence
      && entry.event === "kitty_reply"
      && entry.id === "I04"
      && stringField(entry, "payload_base64") === expectedPayload
    ),
    { timeoutMs: E2E_TIMEOUT },
  );
  expect(stringField(reply, "payload_base64")).toBe(expectedPayload);
  const entries = await server.readTranscript(terminalId);
  const replies = entries.filter((entry) => (
    typeof entry.sequence === "number"
    && entry.sequence > querySequence
    && entry.event === "kitty_reply"
    && entry.id === "I04"
  ));
  expect(replies).toHaveLength(1);
}
test("I-04 Kitty keyboard protocol @pr @nightly @input @kitty @reconnect", async ({ page, baseURL, server }, testInfo) => {
  const login = new LoginPage(page);
  await page.goto(baseURL);
  await login.login();
  await page.setViewportSize({ width: 800, height: 700 });

  const workbench = new WorkbenchPage(page);
  await workbench.createTerminal();
  const paneLocator = page.locator('section[role="region"][data-terminal-id]').first();
  await expect(paneLocator).toBeVisible();
  const terminalId = await paneLocator.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("new terminal did not expose a terminal ID");
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalConnected(page, terminalId, { timeout: E2E_TIMEOUT });
  await expectTerminalSynchronized(page, terminalId, { timeout: E2E_TIMEOUT });
  await pane.focus();

  await command(page, pane, terminalId, server, "READY I04", "READY");
  await waitForMarker(page, terminalId, "[E2E:READY:I04]");
  const beforePixels = await screenshotRegion(page, pane.xtermHost);

  await kittyCommand(page, pane, terminalId, server, "SET", 1);
  await kittyCommand(page, pane, terminalId, server, "PUSH", 3);
  await kittyCommand(page, pane, terminalId, server, "PUSH", 7);
  await expectKittyQueryReply(server, terminalId, await kittyCommand(page, pane, terminalId, server, "QUERY"), 7);

  await command(page, pane, terminalId, server, "ALT_ENTER I04", "ALT_ENTER");
  await expectActiveBuffer(page, terminalId, "alternate", { timeout: E2E_TIMEOUT });
  await kittyCommand(page, pane, terminalId, server, "SET", 2);
  await kittyCommand(page, pane, terminalId, server, "PUSH", 5);
  await kittyCommand(page, pane, terminalId, server, "PUSH", 9);
  await expectKittyQueryReply(server, terminalId, await kittyCommand(page, pane, terminalId, server, "QUERY"), 9);

  await command(page, pane, terminalId, server, "ALT_EXIT I04", "ALT_EXIT");
  await expectActiveBuffer(page, terminalId, "normal", { timeout: E2E_TIMEOUT });
  await expectKittyQueryReply(server, terminalId, await kittyCommand(page, pane, terminalId, server, "QUERY"), 7);
  await kittyCommand(page, pane, terminalId, server, "POP", 1);
  await expectKittyQueryReply(server, terminalId, await kittyCommand(page, pane, terminalId, server, "QUERY"), 3);
  await kittyCommand(page, pane, terminalId, server, "RESET");
  await expectKittyQueryReply(server, terminalId, await kittyCommand(page, pane, terminalId, server, "QUERY"), 0);

  await kittyCommand(page, pane, terminalId, server, "SET", 1);
  await captureInput(page, pane, terminalId, server, "I04_SHIFT_ENTER", "\u001b[13;2u", () => pane.press("Shift+Enter"));
  await captureInput(page, pane, terminalId, server, "I04_CTRL_C", "\u001b[99;5u", () => pane.press("Control+c"));
  await expect(pane.root.locator(".terminal-keybar")).toBeVisible();
  await captureInput(page, pane, terminalId, server, "I04_ESC", "\u001b[27u", async () => {
    await pane.root.locator(".terminal-keybar").getByRole("button", { name: "Esc", exact: true }).click();
  });
  await pane.focus();
  await waitForFocused(pane);

  await kittyCommand(page, pane, terminalId, server, "SET", 8);
  await captureInput(page, pane, terminalId, server, "I04_TAB", "\u001b[9u", async () => {
    await pane.root.locator(".terminal-keybar").getByRole("button", { name: "Tab", exact: true }).click();
  });
  await pane.focus();
  await waitForFocused(pane);

  // Keep a non-empty alternate stack across reconnect; POP after recovery must
  // restore report-all-keys (8) before the post-reconnect Tab capture.
  await kittyCommand(page, pane, terminalId, server, "PUSH", 1);
  const beforeReconnect = await latestSnapshot(page, terminalId);
  const closeBaseline = await latestEventId(pane);
  await page.evaluate(({ id, generation }) => {
    const api = window.__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.socket.close(id, { generation, abrupt: true, reason: "I04 reconnect" });
  }, { id: terminalId, generation: beforeReconnect.socketGeneration });
  const closeEventId = await waitForEventAfter(page, terminalId, closeBaseline, "socket-close");
  await waitForEventAfter(page, terminalId, closeEventId, "synced");
  const afterReconnect = await latestSnapshot(page, terminalId);
  expect(afterReconnect.socketGeneration).toBeGreaterThan(beforeReconnect.socketGeneration);
  expect(afterReconnect.activeSocketCount).toBe(1);
  expect(afterReconnect.socketState).toBe("connected");
  expect(afterReconnect.syncMode).toBeUndefined();
  expect(afterReconnect.pendingParserWrites).toBe(0);
  expect(afterReconnect.pendingParserBytes).toBe(0);
  expect(afterReconnect.renderBacklogBytes).toBe(0);
  expect(beforeReconnect.gridEpoch).toBeDefined();
  expect(afterReconnect.gridEpoch).toBeDefined();
  const recoverySync = (await pane.events()).filter((event) => event.type === "sync" && event.id > closeEventId);
  expect(recoverySync).toHaveLength(1);
  const mode = recoverySync[0]?.snapshot.syncMode ?? recoverySync[0]?.data.mode;
  expect(["resume", "snapshot"]).toContain(mode);
  if (mode === "resume") expect(afterReconnect.gridEpoch).toBe(beforeReconnect.gridEpoch);

  await expectKittyQueryReply(server, terminalId, await kittyCommand(page, pane, terminalId, server, "QUERY"), 1);
  await kittyCommand(page, pane, terminalId, server, "POP", 1);
  await captureInput(page, pane, terminalId, server, "I04_POST_RECONNECT_TAB", "\u001b[9u", async () => {
    await pane.root.locator(".terminal-keybar").getByRole("button", { name: "Tab", exact: true }).click();
  });
  await kittyCommand(page, pane, terminalId, server, "RESET");

  await command(page, pane, terminalId, server, "ECHO_INPUT I04_RECONNECTED", "ECHO_INPUT");
  const payload = "I04_RECONNECTED_MARKER";
  const echoBefore = latestSequence(await server.readTranscript(terminalId));
  await sendFixtureCommand(pane, payload);
  const echo = await server.waitForTranscript(
    terminalId,
    (entry) => (
      typeof entry.sequence === "number"
      && entry.sequence > echoBefore
      && entry.event === "echo_input"
      && entry.id === "I04_RECONNECTED"
      && entry.phase === "payload"
      && stringField(entry, "payload_base64") === base64(payload)
    ),
    { timeoutMs: E2E_TIMEOUT },
  );
  expect(numberField(echo, "bytes")).toBe(encoder.encode(payload).byteLength);
  await waitForMarker(page, terminalId, `[E2E:ECHO_INPUT:I04_RECONNECTED:${base64(payload)}]`);

  await command(page, pane, terminalId, server, "SIZE I04_FINAL", "SIZE");
  const sizeEntries = await server.readTranscript(terminalId);
  const size = sizeEntries.find((entry) => entry.event === "size" && entry.id === "I04_FINAL");
  if (!size) throw new Error("fixture did not record final PTY size");
  const sizeSnapshot = await latestSnapshot(page, terminalId);
  await expectTerminalConverged(page, terminalId, { rows: sizeSnapshot.rows, cols: sizeSnapshot.cols }, { timeout: E2E_TIMEOUT });
  const final = await latestSnapshot(page, terminalId);
  expect(numberField(size, "rows")).toBe(final.rows);
  expect(numberField(size, "cols")).toBe(final.cols);
  expect(final.serverViewport?.rows).toBe(final.rows);
  expect(final.serverViewport?.cols).toBe(final.cols);
  await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "i04-final-marker-crop",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "i04-final-terminal-crop",
  });

  const events = await pane.events();
  await assertMonotonicSequences(events);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  await expectTerminalConnected(page, terminalId, { timeout: E2E_TIMEOUT });
  await expectSingleTerminalSocket(page, terminalId, { timeout: E2E_TIMEOUT });
  await expectNoPendingRecovery(page, terminalId, { timeout: E2E_TIMEOUT });
  const settled = await latestSnapshot(page, terminalId);
  expect(settled.socketState).toBe("connected");
  expect(settled.activeSocketCount).toBe(1);
  expect(settled.syncMode).toBeUndefined();
  expect(settled.pendingParserWrites).toBe(0);
  expect(settled.pendingParserBytes).toBe(0);
  expect(settled.renderBacklogBytes).toBe(0);
  expect(settled.renderBacklogFrames).toBe(0);
  expect(settled.acceptingInput).toBe(true);
  const responderSizes = events.filter((event) => (
    (event.type as string) === "size" && event.data.responder === true
  ));
  expect(responderSizes.length).toBeGreaterThan(0);

  const transcript = await server.readTranscript(terminalId);
  const kittyEvents = transcript.filter((entry) => entry.event === "kitty" && entry.id === "I04");
  expect(kittyEvents.map((entry) => entry.action)).toEqual([
    "set", "push", "push", "query",
    "set", "push", "push", "query",
    "query", "pop", "query", "reset", "query",
    "set", "set", "push",
    "query", "pop", "reset",
  ]);
  const captureIds = [
    "I04_SHIFT_ENTER", "I04_CTRL_C", "I04_ESC", "I04_TAB",
    "I04_POST_RECONNECT_TAB",
  ];
  for (const id of captureIds) {
    expect(transcript.filter((entry) => (
      entry.event === "capture_input" && entry.id === id && entry.phase === "complete"
    ))).toHaveLength(1);
  }
  expect(transcript.filter((entry) => entry.event === "kitty_reply" && entry.id === "I04")).toHaveLength(6);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === "I04_RECONNECTED" && entry.phase === "payload")).toHaveLength(1);
});
