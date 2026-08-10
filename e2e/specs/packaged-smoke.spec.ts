import { expect, test } from "../fixtures/test.js";
import {
  changedPixelRatio,
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 20_000;

test("Packaged production client PTY smoke @packaged @smoke", async ({ page, server, baseURL }, testInfo) => {
  await page.goto(baseURL);
  const login = new LoginPage(page);
  await login.expectVisible();
  await login.login();

  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as { id: string; name: string };
  expect(created.id).not.toBe("");

  await workbench.expectVisibleTerminal(created.id);
  const pane = workbench.terminal(created.id, created.name);
  await pane.expectVisible();
  const terminalViewport = pane.xtermHost.locator(".xterm-screen");
  await expect(terminalViewport).toBeVisible();

  const readyId = "PACKAGED_READY";
  const readyCommand = `READY ${readyId}`;
  await pane.sendInput(readyCommand, true);
  await server.waitForTranscript(
    created.id,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const beforePrint = await screenshotRegion(page, terminalViewport);
  const printId = "PACKAGED_PRINT";
  const printText = "production-output";
  const printCommand = `PRINT ${printId} ${printText}`;
  await pane.sendInput(printCommand, true);
  await server.waitForTranscript(
    created.id,
    (entry) => entry.event === "print" && entry.id === printId && entry.text === printText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  let afterPrint = beforePrint;
  await expect.poll(async () => {
    afterPrint = await screenshotRegion(page, terminalViewport);
    return changedPixelRatio(beforePrint, afterPrint);
  }, { timeout: WAIT_TIMEOUT_MS }).toBeGreaterThanOrEqual(0.002);
  await expectTerminalPixelsChanged(beforePrint, afterPrint, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "packaged-smoke-after-print-crop",
  });

  const inputId = "PACKAGED_INPUT";
  const inputText = "real-xterm-input";
  const inputCommand = `ECHO_INPUT ${inputId}`;
  await pane.sendInput(inputCommand, true);
  await server.waitForTranscript(
    created.id,
    (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  const inputEntry = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
    created.id,
    (entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(inputEntry.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));

  await expectTerminalNonBlank(page, terminalViewport, {
    minimumNonBackgroundRatio: 0.002,
    testInfo,
    artifactName: "packaged-smoke-terminal-crop",
  });

  const transcript = await server.readTranscript(created.id);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  for (const [operation, command] of [
    ["READY", readyCommand],
    ["PRINT", printCommand],
    ["ECHO_INPUT", inputCommand],
    ["ECHO_INPUT", inputText],
  ] as const) {
    expect(
      transcript.filter((entry) => (
        entry.event === "command"
        && entry.operation === operation
        && entry.command_base64 === Buffer.from(command, "utf8").toString("base64")
      )),
      `fixture command missing or duplicated: ${command}`,
    ).toHaveLength(1);
  }
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === printId && entry.text === printText)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === inputId && entry.phase === "payload")).toHaveLength(1);
});
