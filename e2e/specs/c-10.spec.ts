import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalInteractive,
  terminalEvents,
  terminalSnapshot,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import {
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo | undefined> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    return terminals.find((terminal) => terminal.id === id);
  }, terminalId);
}

async function waitForDisconnected(page: Page, terminalId: string): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.type === "state"
        && event.data.state === "disconnected"
        && event.snapshot.socketState === "disconnected"
        && event.snapshot.activeSocketCount === 0,
      { timeout },
    );
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function readTerminalIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    return (await response.json() as TerminalApiInfo[]).map((terminal) => terminal.id);
  });
}

function expectProcessTerminated(pid: number): void {
  let errorCode: string | undefined;
  try {
    process.kill(pid, 0);
  } catch (error) {
    errorCode = (error as NodeJS.ErrnoException).code;
  }
  expect(errorCode).toBe("ESRCH");
}

test("C-10 Terminal removed during reconnect @p1 @nightly", async ({
  page,
  server,
  faultController,
  baseURL,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `C010-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const readyId = `${runTag}-ready`;
  const beforeRemoveId = `${runTag}-before-remove`;
  const beforeRemoveText = `${runTag}-before-remove-text`;
  const holdToken = `${runTag}-gate`;
  const echoId = `${runTag}-continued-input`;
  const inputText = `${runTag}-input-before-remove`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/terminals";
  });
  await workbench.createTerminal();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as TerminalApiInfo;
  expect(created.id).not.toBe("");
  expect(created.name).not.toBe("");
  const terminalId = created.id;
  const pane = new TerminalPanePage(page, terminalId, created.name);
  await pane.expectVisible();
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const initialTerminal = await readTerminal(page, terminalId);
  expect(initialTerminal?.status).toBe("running");
  expect(initialTerminal?.pid).toEqual(expect.any(Number));
  const fixturePid = initialTerminal?.pid;
  if (fixturePid === undefined || fixturePid === null) {
    throw new Error(`terminal ${terminalId} did not expose a running fixture PID`);
  }

  await pane.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "ready" && entry.id === readyId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:READY:${readyId}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  await pane.sendInput(`PRINT ${beforeRemoveId} ${beforeRemoveText}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === beforeRemoveId && entry.text === beforeRemoveText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${beforeRemoveId}:${beforeRemoveText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c-10-before-remove-terminal",
  });
  const beforeRemovePixels = await screenshotRegion(page, workbench.workspaceArea);

  // Verify the PTY accepted input before the terminal is removed; no input can
  // be sent after removal because the production path intentionally destroys
  // the terminal session.
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(inputText, true);
  const echoed = await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "echo_input"
      && entry.id === echoId
      && entry.phase === "payload"
      && entry.payload_base64 === Buffer.from(inputText, "utf8").toString("base64"),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echoed.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));

  await pane.sendInput(`HOLD ${holdToken}`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "hold" && entry.token === holdToken,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const beforeDisconnect = await terminalSnapshot(page, terminalId);
  if (!beforeDisconnect) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  expect(beforeDisconnect.socketState).toBe("connected");
  expect(beforeDisconnect.activeSocketCount).toBe(1);
  expect(beforeDisconnect.socket.activeCount).toBe(1);
  expect(beforeDisconnect.acceptingInput).toBe(true);
  assertNoPendingSynchronization(beforeDisconnect);
  const beforeEvents = await terminalEvents(page, terminalId);
  const beforeEventId = beforeEvents.at(-1)?.id ?? 0;

  const delayedReconnect = faultController.delayUpgrade({ terminalId }, WAIT_TIMEOUT_MS);
  const reconnectDelayedPromise = faultController.waitFor(
    (event) => event.type === "upgrade-delay" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const reconnectCreatedPromise = page.evaluate(async ({ id, afterId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => event.id > afterId && event.type === "socket-created",
      { timeout, afterId },
    );
  }, { id: terminalId, afterId: beforeEventId, timeout: WAIT_TIMEOUT_MS });
  const socketClosePromise = pane.waitForEvent("socket-close", { timeout: WAIT_TIMEOUT_MS });
  const disconnectedPromise = waitForDisconnected(page, terminalId);
  const terminatedPromise = faultController.waitFor(
    (event) => event.type === "connection-terminated" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const terminateRule = faultController.terminate({ terminalId });
  const [terminated, socketClose, disconnected, reconnectDelayed, reconnectCreated] = await Promise.all([
    terminatedPromise,
    socketClosePromise,
    disconnectedPromise,
    reconnectDelayedPromise,
    reconnectCreatedPromise,
  ]);
  terminateRule.dispose();

  expect(terminated.abrupt).toBe(true);
  expect(terminated.code).toBe(1006);
  expect(socketClose.data.generation).toBe(beforeDisconnect.socketGeneration);
  expect(reconnectDelayed.generation).toBeGreaterThan(beforeDisconnect.socketGeneration);
  expect(reconnectCreated.data.generation).toBeGreaterThan(beforeDisconnect.socketGeneration);
  expect(disconnected.snapshot.socketState).toBe("disconnected");
  expect(disconnected.snapshot.activeSocketCount).toBe(0);
  expect(disconnected.snapshot.socket.activeCount).toBe(0);
  expect(disconnected.snapshot.lifecycle.acceptingInput).toBe(false);

  const disconnectedSnapshot = disconnected.snapshot;
  const disconnectedEvents = await terminalEvents(page, terminalId);
  expect(disconnectedEvents.some((event) => event.id > beforeEventId && event.type === "state" && event.data.state === "disconnected")).toBe(true);
  await assertMonotonicSequences(disconnectedEvents);
  assertNoUnexpectedSocketMultiplication([beforeDisconnect, disconnectedSnapshot]);

  const unmountPromise = pane.waitForEvent("unmount", { timeout: WAIT_TIMEOUT_MS });
  const removeResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "DELETE"
      && url.pathname === `/api/terminals/${terminalId}`;
  });
  await workbench.sidebar.removeTerminal({ id: terminalId, name: created.name });
  const [removeResponse, unmounted] = await Promise.all([removeResponsePromise, unmountPromise]);
  expect(removeResponse.status()).toBe(204);
  expect(unmounted.type).toBe("unmount");
  expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
  expect(unmounted.snapshot.lifecycle.visible).toBe(false);
  expect(unmounted.snapshot.lifecycle.cached).toBe(true);
  expect(unmounted.snapshot.lifecycle.active).toBe(false);
  expect(unmounted.snapshot.lifecycle.acceptingInput).toBe(false);
  expect(unmounted.snapshot.activeSocketCount).toBe(0);
  expect(unmounted.snapshot.socket.activeCount).toBe(0);
  expect(unmounted.snapshot.socketGeneration).toBe(reconnectCreated.data.generation);
  expect(faultController.events.filter((event) => (
    event.terminalId === terminalId && event.type === "upgrade-request"
  ))).toHaveLength(2);
  delayedReconnect.dispose();

  await expect(pane.root).toHaveCount(0);
  await expect(page.locator(`[data-terminal-id="${terminalId.replace(/(["\\])/g, "\\$1")}"]`)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(`[E2E:PRINT:${beforeRemoveId}:${beforeRemoveText}]`);
  const afterRemovePixels = await screenshotRegion(page, workbench.workspaceArea);
  await expectTerminalPixelsChanged(beforeRemovePixels, afterRemovePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c-10-after-remove-workspace",
  });

  const listedTerminalIds = await readTerminalIds(page);
  expect(listedTerminalIds).not.toContain(terminalId);
  expect(await pane.snapshot()).toBeUndefined();
  expect(await pane.events()).toEqual([]);
  expectProcessTerminated(fixturePid);

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === beforeRemoveId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  expect(transcript.filter((entry) => entry.event === "hold" && entry.token === holdToken)).toHaveLength(1);

  const afterRemovalErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  expect(afterRemovalErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/\b(?:panic|internal server error)\b/i);
});
