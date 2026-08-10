import { expect, test } from "../fixtures/test.js";
import type { Locator, Page } from "@playwright/test";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalConverged,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";

const COMPOSED_TEXT = "猫";
const CARRIAGE_RETURN = Buffer.from([0x0d]);

type FixturePane = {
  readonly terminalId: string;
  readonly pane: TerminalPanePage;
};

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function transcriptBytes(entry: TranscriptEntry): Buffer {
  const encoded = entry.command_base64;
  if (typeof encoded !== "string") throw new Error("fixture command has no command_base64 field");
  return Buffer.from(encoded, "base64");
}

function marker(operation: string, id: string, text?: string): string {
  return text === undefined
    ? `[E2E:${operation}:${id}]\n`
    : `[E2E:${operation}:${id}:${text}]\n`;
}

async function waitForMarker(
  server: IsolatedServer,
  terminalId: string,
  expected: string,
): Promise<void> {
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "write" && entry.text === expected,
  );
}

async function waitForCommand(
  server: IsolatedServer,
  terminalId: string,
  command: string,
): Promise<TranscriptEntry> {
  const expectedBase64 = base64(command);
  return server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "command" && entry.command_base64 === expectedBase64,
  );
}

async function expectAcceptedCommandOnce(
  server: IsolatedServer,
  terminalId: string,
  command: string,
): Promise<void> {
  const entries = await server.readTranscript(terminalId);
  const matches = entries.filter(
    (entry) => entry.event === "command" && entry.command_base64 === base64(command),
  );
  expect(matches, `fixture accepted command ${JSON.stringify(command)} more than once`).toHaveLength(1);
  const acceptedBytes = transcriptBytes(matches[0]!);
  expect(Buffer.concat([acceptedBytes, CARRIAGE_RETURN])).toEqual(
    Buffer.concat([Buffer.from(command, "utf8"), CARRIAGE_RETURN]),
  );
}

async function nextAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function createFixturePane(page: Page, baseURL: string): Promise<FixturePane> {
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.createTerminal();

  const terminalElement = workbench.editorGrid.locator("[data-terminal-id]").first();
  await expect(terminalElement).toBeVisible();
  const terminalId = await terminalElement.getAttribute("data-terminal-id");
  if (!terminalId) throw new Error("created terminal has no stable terminal ID");

  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  await pane.waitForSynchronized();
  await pane.expectConnected();
  await pane.focus();
  return { terminalId, pane };
}

async function dispatchCompositionStart(textarea: Locator): Promise<void> {
  await textarea.focus();
  await textarea.evaluate((element) => {
    const target = element as HTMLTextAreaElement;
    target.value = "";
    target.setSelectionRange(0, 0);
    target.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Unidentified",
      isComposing: true,
      key: "Process",
      keyCode: 229,
      which: 229,
    }));
    target.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      cancelable: true,
      data: "",
    }));
  });
}

async function dispatchCompositionUpdate(textarea: Locator, data: string): Promise<void> {
  await textarea.evaluate((element, compositionData) => {
    const target = element as HTMLTextAreaElement;
    const value = compositionData as string;
    target.value = value;
    target.setSelectionRange(0, value.length);
    target.dispatchEvent(new CompositionEvent("compositionupdate", {
      bubbles: true,
      cancelable: true,
      data: value,
    }));
    const input = typeof InputEvent === "function"
      ? new InputEvent("input", {
          bubbles: true,
          composed: true,
          data: value,
          inputType: "insertCompositionText",
        })
      : new Event("input", { bubbles: true });
    target.dispatchEvent(input);
  }, data);
}

async function dispatchCompositionEnd(
  textarea: Locator,
): Promise<void> {
  await textarea.evaluate((element, data) => {
    const target = element as HTMLTextAreaElement;
    target.value = data as string;
    target.setSelectionRange(0, (data as string).length);
    target.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      cancelable: true,
      data: data as string,
    }));
    const input = typeof InputEvent === "function"
      ? new InputEvent("input", {
          bubbles: true,
          composed: true,
          data: data as string,
          inputType: "insertText",
        })
      : new Event("input", { bubbles: true });
    target.dispatchEvent(input);
    target.dispatchEvent(new KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      code: "Unidentified",
      isComposing: false,
      key: "Process",
      keyCode: 229,
      which: 229,
    }));
  }, COMPOSED_TEXT);
}

async function dispatchCompositionEnterWhileActive(
  textarea: Locator,
): Promise<void> {
  await textarea.evaluate((element) => {
    const target = element as HTMLTextAreaElement;
    target.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Enter",
      isComposing: true,
      key: "Enter",
      keyCode: 229,
      which: 229,
    }));
  });
}

test("I-05 IME/composition @nightly @input @ime", async ({ page, baseURL, server }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

  const { terminalId, pane } = await createFixturePane(page, baseURL);
  const capability = await page.evaluate(() => ({
    compositionEvent: typeof CompositionEvent === "function",
  }));
  const textarea = pane.xtermHost.locator(".xterm-helper-textarea");
  const helperCount = await textarea.count();
  const unavailable: string[] = [];
  if (!capability.compositionEvent) unavailable.push("CompositionEvent is unavailable");
  if (helperCount !== 1) unavailable.push("xterm helper textarea is unavailable");
  if (unavailable.length > 0) {
    test.skip(true, `@ime capability unavailable: ${unavailable.join("; ")}`);
  }
  expect(helperCount).toBe(1);

  const markerSuffix = `${testInfo.workerIndex}_${testInfo.parallelIndex}_${testInfo.repeatEachIndex}`;
  const readyId = `I05_READY_${markerSuffix}`;
  const composedId = `I05_COMPOSED_${markerSuffix}`;
  const activeId = `I05_ACTIVE_${markerSuffix}`;
  const afterId = `I05_AFTER_${markerSuffix}`;
  const afterText = "after-composition";

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
  );
  await expectTerminalBuffer(page, terminalId, { contains: `[E2E:READY:${readyId}]`, occurrences: 1 });
  const beforePixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "i05-before-composition",
  });


  const composedCommand = `ECHO_INPUT ${composedId} ${COMPOSED_TEXT}`;
  const composedPrefix = `ECHO_INPUT ${composedId} `;
  await pane.type(composedPrefix);
  await nextAnimationFrame(page);
  const beforeComposition = await server.readTranscript(terminalId);
  const beforeCompositionSnapshot = await terminalSnapshot(page, terminalId);
  expect(beforeCompositionSnapshot).toBeDefined();
  await dispatchCompositionStart(textarea);
  expect(await server.readTranscript(terminalId)).toEqual(beforeComposition);
  await dispatchCompositionUpdate(textarea, "n");
  expect(await server.readTranscript(terminalId)).toEqual(beforeComposition);
  await dispatchCompositionUpdate(textarea, COMPOSED_TEXT);
  expect(await server.readTranscript(terminalId)).toEqual(beforeComposition);
  const duringCompositionSnapshot = await terminalSnapshot(page, terminalId);
  expect(duringCompositionSnapshot?.xterm.text).toBe(beforeCompositionSnapshot?.xterm.text);
  expect(duringCompositionSnapshot?.pendingParserWrites).toBe(0);

  await dispatchCompositionEnd(textarea);
  await nextAnimationFrame(page);
  const beforeFirstEnter = await server.readTranscript(terminalId);
  expect(beforeFirstEnter).toEqual(beforeComposition);
  await pane.press("Enter");
  await waitForCommand(server, terminalId, composedCommand);
  await waitForMarker(server, terminalId, marker("ECHO_INPUT", composedId, COMPOSED_TEXT));

  const activeCommand = `ECHO_INPUT ${activeId} ${COMPOSED_TEXT}`;
  const activePrefix = `ECHO_INPUT ${activeId} `;
  await pane.type(activePrefix);
  await nextAnimationFrame(page);
  const beforeActiveComposition = await server.readTranscript(terminalId);
  const beforeActiveCompositionSnapshot = await terminalSnapshot(page, terminalId);
  expect(beforeActiveCompositionSnapshot).toBeDefined();
  await dispatchCompositionStart(textarea);
  expect(await server.readTranscript(terminalId)).toEqual(beforeActiveComposition);
  await dispatchCompositionUpdate(textarea, "n");
  expect(await server.readTranscript(terminalId)).toEqual(beforeActiveComposition);
  await dispatchCompositionUpdate(textarea, COMPOSED_TEXT);
  expect(await server.readTranscript(terminalId)).toEqual(beforeActiveComposition);
  await dispatchCompositionEnterWhileActive(textarea);
  const afterActiveEnter = await server.readTranscript(terminalId);
  expect(afterActiveEnter).toEqual(beforeActiveComposition);
  const activeSnapshot = await terminalSnapshot(page, terminalId);
  expect(activeSnapshot?.xterm.text).toBe(beforeActiveCompositionSnapshot?.xterm.text);

  await dispatchCompositionEnd(textarea);
  await nextAnimationFrame(page);
  const beforeActiveFinalEnter = await server.readTranscript(terminalId);
  expect(beforeActiveFinalEnter).toEqual(beforeActiveComposition);
  await pane.press("Enter");
  await waitForCommand(server, terminalId, activeCommand);
  await waitForMarker(server, terminalId, marker("ECHO_INPUT", activeId, COMPOSED_TEXT));

  const afterCommand = `PRINT ${afterId} ${afterText}`;
  await pane.sendInput(afterCommand, true);
  await waitForCommand(server, terminalId, afterCommand);
  await waitForMarker(server, terminalId, marker("PRINT", afterId, afterText));
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${afterId}:${afterText}]`,
    occurrences: 1,
  });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${composedId}:${COMPOSED_TEXT}]`,
    occurrences: 1,
  });
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:ECHO_INPUT:${activeId}:${COMPOSED_TEXT}]`,
    occurrences: 1,
  });

  const afterPixels = await screenshotRegion(page, pane.xtermHost);
  await expectTerminalPixelsChanged(beforePixels, afterPixels, {
    testInfo,
    artifactName: "i05-after-composition",
  });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "i05-final-terminal",
  });

  const transcript = await server.readTranscript(terminalId);
  await expectAcceptedCommandOnce(server, terminalId, composedCommand);
  await expectAcceptedCommandOnce(server, terminalId, activeCommand);
  await expectAcceptedCommandOnce(server, terminalId, afterCommand);
  for (const [id, text] of [[composedId, COMPOSED_TEXT], [activeId, COMPOSED_TEXT]] as const) {
    const echoEntries = transcript.filter(
      (entry) => entry.event === "echo_input" && entry.id === id && entry.phase === "payload",
    );
    expect(echoEntries, `fixture echoed ${id} more than once`).toHaveLength(1);
    expect(echoEntries[0]?.text).toBe(text);
    const writes = transcript.filter(
      (entry) => entry.event === "write" && entry.text === marker("ECHO_INPUT", id, text),
    );
    expect(writes, `fixture marker for ${id} was duplicated`).toHaveLength(1);
  }
  expect(transcript.filter((entry) => entry.event === "write" && entry.text === marker("PRINT", afterId, afterText))).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error"), "fixture reported an error").toEqual([]);

  const report = await expectConnectedTerminalInvariants(page, terminalId);
  await assertMonotonicSequences(report.events);
  expect(report.snapshot.pendingParserWrites).toBe(0);
  expect(report.snapshot.pendingParserBytes).toBe(0);
  expect(report.snapshot.renderBacklogBytes).toBe(0);
  expect(report.snapshot.renderBacklogFrames).toBe(0);
  const socketCreated = report.events.filter((event) => event.type === "socket-created");
  expect(socketCreated).toHaveLength(1);
  expect(socketCreated[0]?.data.generation).toBe(report.snapshot.socketGeneration);
  expect(report.events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(report.snapshot.syncMode).toBeUndefined();
  expect(report.snapshot.syncTarget === undefined || report.snapshot.committedSequence === undefined || report.snapshot.committedSequence >= report.snapshot.syncTarget).toBe(true);
  expect(report.snapshot.activeSocketCount).toBe(1);
  expect(report.snapshot.socket.activeCount).toBe(1);
  expect(report.snapshot.socketState).toBe("connected");
  expect(report.snapshot.acceptingInput).toBe(true);

  const dimensions = report.snapshot.proposedViewport ?? report.snapshot.viewport;
  expect(dimensions.cols).toBeGreaterThan(0);
  expect(dimensions.rows).toBeGreaterThan(0);
  await expectTerminalConverged(page, terminalId, {
    cols: dimensions.cols,
    rows: dimensions.rows,
  });
  const finalSnapshot = await terminalSnapshot(page, terminalId);
  expect(finalSnapshot?.serverViewport?.cols).toBe(dimensions.cols);
  expect(finalSnapshot?.serverViewport?.rows).toBe(dimensions.rows);
  expect(finalSnapshot?.cols).toBe(dimensions.cols);
  expect(finalSnapshot?.rows).toBe(dimensions.rows);

  const events = await terminalEvents(page, terminalId);
  expect(events.filter((event) => event.type === "error"), "browser diagnostics reported an error").toEqual([]);
  await assertMonotonicSequences(events);
  expect(browserErrors, "composition produced a browser console or page error").toEqual([]);
  expect(server.pid).toBeDefined();
  expect(server.process?.exitCode ?? null).toBeNull();
});
