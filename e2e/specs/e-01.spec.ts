import { Buffer } from "node:buffer";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import {
  assertMonotonicSequences,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const EXIT_CODES = [0, 23] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly clients: number;
};

function countOccurrences(value: string, needle: string): number {
  const comparable = value.replaceAll("\n", "");
  let count = 0;
  let offset = 0;
  while (true) {
    const index = comparable.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
}

function unexpectedBrowserErrors(entries: readonly { kind: string; message: string }[]): readonly unknown[] {
  return entries.filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "requestfailed"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} was not found in the server listing`);
    return terminal;
  }, terminalId);
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEvent["type"],
  dataField?: string,
  dataValue?: string | number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, field, value, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(
      id,
      (event) => (
        event.id > after
        && event.type === eventType
        && (field === undefined || event.data[field] === value)
      ),
      { timeout, afterId: after },
    );
  }, {
    id: terminalId,
    after: afterEventId,
    eventType: type,
    field: dataField,
    value: dataValue,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForQuiescentTerminal(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

for (const exitCode of EXIT_CODES) {
  test(`E-01 Normal and nonzero exit (${exitCode}) @e @lifecycle @nightly`, async ({
    browser,
    page,
    baseURL,
    server,
    faultController,
  }, testInfo) => {
    const browserErrors = installBrowserErrorCollectors(page);
    let freshContext: BrowserContext | undefined;
    let freshErrors: BrowserErrorCollector | undefined;

    const runTag = `w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}-x${exitCode}`;
    const readyId = `E01_READY_${runTag}`;
    const echoId = `E01_ECHO_${runTag}`;
    const echoText = `E01_INPUT_CONTINUES_${runTag}`;
    const finalId = `E01_FINAL_${runTag}`;
    const finalText = `E01_FINAL_OUTPUT_${runTag}`;
    const readyMarker = `[E2E:READY:${readyId}]`;
    const echoMarker = `[E2E:ECHO_INPUT:${echoId}:${Buffer.from(echoText, "utf8").toString("base64")}]`;
    const finalMarker = `[E2E:PRINT:${finalId}:${finalText}]`;

    try {
      await page.goto(baseURL);
      await new LoginPage(page).login();
      const workbench = new WorkbenchPage(page);
      await workbench.expectVisible();

      const mountedPromise = page.evaluate(async (timeout) => {
        const api = (window as E2EWindow).__TERM_SERVER_E2E__;
        if (!api) throw new Error("term-server E2E diagnostics are unavailable");
        return api.waitForEvent(
          (event) => event.type === "mount" && event.snapshot.kind === "pane",
          { timeout },
        );
      }, WAIT_TIMEOUT_MS);
      const createResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "POST" && url.pathname === "/api/terminals";
      });
      await workbench.createTerminal();
      const [mounted, createResponse] = await Promise.all([mountedPromise, createResponsePromise]);
      expect(createResponse.ok()).toBe(true);
      const created = await createResponse.json() as TerminalApiInfo;
      expect(created.id).not.toBe("");
      expect(created.status).toBe("running");
      expect(created.pid).not.toBeNull();
      expect(mounted.terminalId).toBe(created.id);

      const terminalId = created.id;
      const pane = workbench.terminal(terminalId, created.name);
      await pane.expectVisible();
      const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      expect(initial.socketState).toBe("connected");
      expect(initial.activeSocketCount).toBe(1);
      expect(initial.socket.activeCount).toBe(1);
      expect(initial.acceptingInput).toBe(true);
      expect(initial.serverViewport).toBeDefined();
      expect(initial.serverViewport?.cols).toBe(initial.cols);
      expect(initial.serverViewport?.rows).toBe(initial.rows);
      const initialGeneration = initial.socketGeneration;

      await pane.sendInput(`READY ${readyId}`, true);
      await server.waitForTranscript(
        terminalId,
        (entry) => entry.event === "ready" && entry.id === readyId,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      await expectTerminalBuffer(page, terminalId, { contains: readyMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      await waitForQuiescentTerminal(page, terminalId);

      await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
      await server.waitForTranscript(
        terminalId,
        (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      await pane.sendInput(echoText, true);
      const echoEntry = await server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64: string }>(
        terminalId,
        (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      expect(echoEntry.payload_base64).toBe(Buffer.from(echoText, "utf8").toString("base64"));
      await expectTerminalBuffer(page, terminalId, { contains: echoMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      await waitForQuiescentTerminal(page, terminalId);

      const beforePrintPixels = await screenshotRegion(page, pane.xtermHost.locator(".xterm-screen"));
      const printFloor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
      const printTranscript = server.waitForTranscript(
        terminalId,
        (entry) => entry.event === "print" && entry.id === finalId && entry.text === finalText,
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      const parserCommit = waitForDiagnosticEventAfter(page, terminalId, printFloor, "parser-commit");
      const render = waitForDiagnosticEventAfter(page, terminalId, printFloor, "render");
      await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
      await Promise.all([printTranscript, parserCommit, render]);
      await expectTerminalBuffer(page, terminalId, { contains: finalMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
      const finalPixels = await expectKnownMarkerChanged(page, pane.xtermHost.locator(".xterm-screen"), beforePrintPixels, {
        minimumChangedRatio: 0.002,
        testInfo,
        artifactName: `e-01-${exitCode}-final-marker`,
      });
      await expectTerminalNonBlank(page, pane.xtermHost.locator(".xterm-screen"), {
        testInfo,
        artifactName: `e-01-${exitCode}-final-output`,
      });
      expect(finalPixels.after.width).toBe(beforePrintPixels.width);
      expect(finalPixels.after.height).toBe(beforePrintPixels.height);
      const quiescentBeforeExit = await waitForQuiescentTerminal(page, terminalId);
      expect(quiescentBeforeExit.xterm.text.replaceAll("\n", "")).toContain(finalMarker);

      const exitFloor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? printFloor;
      const exitEventPromise = waitForDiagnosticEventAfter(page, terminalId, exitFloor, "exit", "exitCode", exitCode);
      const socketClosePromise = waitForDiagnosticEventAfter(page, terminalId, exitFloor, "socket-close", "generation", initialGeneration);
      const unmountPromise = waitForDiagnosticEventAfter(page, terminalId, exitFloor, "unmount");
      const proxyClosePromise = faultController.waitFor(
        (event) => (
          (event.type === "connection-closed" || event.type === "connection-terminated")
          && event.terminalId === terminalId
          && event.generation === initialGeneration
        ),
        { timeoutMs: WAIT_TIMEOUT_MS },
      );
      await pane.sendInput(`EXIT ${exitCode}`, true);
      const [exitEvent, socketClose, proxyClose] = await Promise.all([
        exitEventPromise,
        socketClosePromise,
        proxyClosePromise,
      ]);
      expect(exitEvent.type).toBe("exit");
      expect(exitEvent.data.exitCode).toBe(exitCode);
      expect(exitEvent.snapshot.exitCode).toBe(exitCode);
      expect(exitEvent.snapshot.socketState).toBe("exited");
      expect(exitEvent.snapshot.acceptingInput).toBe(false);
      expect(exitEvent.snapshot.lifecycle.acceptingInput).toBe(false);
      expect(exitEvent.snapshot.socketGeneration).toBe(initialGeneration);
      const exitText = exitEvent.snapshot.xterm.text.replaceAll("\n", "");
      expect(exitText).toContain(finalMarker);
      expect(countOccurrences(exitText, finalMarker)).toBe(1);
      expect(socketClose.snapshot.socketState).toBe("exited");
      expect(socketClose.snapshot.activeSocketCount).toBe(0);
      expect(socketClose.snapshot.socket.activeCount).toBe(0);
      expect(proxyClose.terminalId).toBe(terminalId);
      expect(proxyClose.generation).toBe(initialGeneration);

      await expect(pane.root.getByText(`Process exited with code ${exitCode}`, { exact: true })).toBeVisible();
      const exitedInfo = await readTerminal(page, terminalId);
      expect(exitedInfo.status).toBe("exited");
      expect(exitedInfo.exitCode).toBe(exitCode);
      expect(exitedInfo.pid).toBeNull();
      expect(exitedInfo.clients).toBe(0);
      expect(server.process?.exitCode ?? null).toBeNull();

      const transcript = await server.readTranscript(terminalId);
      const printIndex = transcript.findIndex((entry) => entry.event === "print" && entry.id === finalId);
      const exitRequestedIndex = transcript.findIndex((entry) => entry.event === "exit_requested" && entry.code === exitCode);
      const exitIndex = transcript.findIndex((entry) => entry.event === "exit" && entry.code === exitCode);
      expect(printIndex).toBeGreaterThanOrEqual(0);
      expect(exitRequestedIndex).toBeGreaterThan(printIndex);
      expect(exitIndex).toBeGreaterThan(exitRequestedIndex);
      expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalId)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "write" && entry.text === `${finalMarker}\n`)).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
      expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
      for (const command of [
        `READY ${readyId}`,
        `ECHO_INPUT ${echoId}`,
        echoText,
        `PRINT ${finalId} ${finalText}`,
        `EXIT ${exitCode}`,
      ]) {
        const commandBase64 = Buffer.from(command, "utf8").toString("base64");
        expect(transcript.filter((entry) => entry.event === "command" && entry.command_base64 === commandBase64), `fixture command duplicated or omitted: ${command}`).toHaveLength(1);
      }

      const events = await terminalEvents(page, terminalId);
      expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
      expect(events.filter((event) => event.type === "socket-open")).toHaveLength(1);
      expect(events.filter((event) => event.type === "socket-close")).toHaveLength(1);
      expect(events.filter((event) => event.type === "exit")).toHaveLength(1);
      expect(events.filter((event) => event.type === "socket-stale")).toEqual([]);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "state" && ["disconnected", "recovering", "connecting"].includes(String(event.data.state)))).toEqual([]);
      await assertMonotonicSequences(events);
      const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
      expect(invariantReport.violations).toEqual([]);
      expect(invariantReport.snapshot.socketState).toBe("exited");
      expect(invariantReport.snapshot.activeSocketCount).toBe(0);
      expect(invariantReport.snapshot.acceptingInput).toBe(false);
      expect(invariantReport.snapshot.renderBacklogBytes).toBe(0);
      expect(invariantReport.snapshot.renderBacklogFrames).toBe(0);
      expect(invariantReport.snapshot.pendingParserWrites).toBe(0);
      expect(invariantReport.snapshot.pendingParserBytes).toBe(0);
      const proxyEvents = faultController.events.filter((event) => event.terminalId === terminalId);
      expect(proxyEvents.filter((event) => event.type === "upgrade-request")).toHaveLength(1);
      expect(proxyEvents.filter((event) => event.type === "connection-open")).toHaveLength(1);
      expect(proxyEvents.filter((event) => event.type === "socket-error")).toEqual([]);
      expect(proxyEvents.filter((event) => event.type === "upgrade-delay")).toEqual([]);

      await pane.closePane();
      const settings = await workbench.openSettings();
      await settings.setCachedTerminalLimit(0);
      const unmounted = await unmountPromise;
      expect(unmounted.type).toBe("unmount");
      expect(unmounted.snapshot.lifecycle.mounted).toBe(false);
      expect(unmounted.snapshot.lifecycle.visible).toBe(false);
      expect(unmounted.snapshot.lifecycle.cached).toBe(true);
      expect(unmounted.snapshot.lifecycle.active).toBe(false);
      expect(unmounted.snapshot.lifecycle.focused).toBe(false);
      expect(unmounted.snapshot.lifecycle.acceptingInput).toBe(false);
      expect(unmounted.snapshot.activeSocketCount).toBe(0);
      expect(unmounted.snapshot.socket.activeCount).toBe(0);
      expect(unmounted.snapshot.socketState).toBe("exited");
      expect(await pane.root.count()).toBe(0);
      expect(await page.locator("canvas").count()).toBe(0);
      const disposedDiagnostics = await page.evaluate((id) => {
        const api = (window as E2EWindow).__TERM_SERVER_E2E__;
        if (!api) throw new Error("term-server E2E diagnostics are unavailable");
        return api.terminal(id);
      }, terminalId);
      expect(disposedDiagnostics).toBeUndefined();
      await workbench.closeSettings();

      freshContext = await browser.newContext({ baseURL });
      const freshPage = await freshContext.newPage();
      freshErrors = installBrowserErrorCollectors(freshPage);
      await freshPage.goto(baseURL);
      await new LoginPage(freshPage).login();
      const freshWorkbench = new WorkbenchPage(freshPage);
      await freshWorkbench.expectVisible();
      const freshInfo = await readTerminal(freshPage, terminalId);
      expect(freshInfo.status).toBe("exited");
      expect(freshInfo.exitCode).toBe(exitCode);
      expect(freshInfo.pid).toBeNull();
      expect(freshInfo.clients).toBe(0);
      expect(await freshWorkbench.visiblePaneCount()).toBe(0);
      const freshRow = await freshWorkbench.sidebar.terminalRow({ id: terminalId, name: created.name });
      await expect(freshRow.locator(".tree-status")).toHaveText(String(exitCode));
      const freshDiagnostics = await freshPage.evaluate((id) => {
        const api = (window as E2EWindow).__TERM_SERVER_E2E__;
        if (!api) throw new Error("term-server E2E diagnostics are unavailable");
        return api.terminal(id);
      }, terminalId);
      expect(freshDiagnostics).toBeUndefined();

      expect(unexpectedBrowserErrors(browserErrors())).toEqual([]);
      if (!freshErrors) throw new Error("fresh-context browser error collector was not installed");
      expect(unexpectedBrowserErrors(freshErrors())).toEqual([]);
      expect(server.stderr).not.toMatch(/\b(?:panic|internal server error|fatal|unhandled)\b/i);
    } finally {
      freshErrors?.dispose();
      await freshContext?.close();
      browserErrors.dispose();
    }
  });
}
