import { Buffer } from "node:buffer";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.js";
import { installBrowserErrorCollectors, type BrowserErrorCollector } from "../fixtures/artifacts.js";
import type { NetworkFaultController } from "../fixtures/network-faults.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConnected,
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
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_STREAM_PROTOCOL } from "../../src/client/lib/terminal-socket.js";

const WAIT_TIMEOUT_MS = 30_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type TerminalApiInfo = {
  readonly id: string;
  readonly pid: number | null;
  readonly status: "running" | "exited";
  readonly clients: number;
};

type BrowserSocketOutcome = {
  readonly opened: boolean;
  readonly code: number;
  readonly reason: string;
};

function runTag(testInfo: { readonly project: { readonly name: string }; readonly workerIndex: number; readonly parallelIndex: number; readonly retry: number; readonly repeatEachIndex: number }): string {
  return `E05-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}-i${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
}

function websocketUrl(origin: string, terminalId: string): string {
  const url = new URL(`/api/terminals/${terminalId}/socket`, origin);
  url.searchParams.set("stream", String(TERMINAL_STREAM_PROTOCOL));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function httpUpgradeUrl(socketUrl: string): string {
  return socketUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

function upgradeHeaders(origin: string, cookie?: string): Record<string, string> {
  return {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    Origin: origin,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/terminals", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`terminal listing failed with HTTP ${response.status}`);
    const terminals = await response.json() as TerminalApiInfo[];
    const terminal = terminals.find((candidate) => candidate.id === id);
    if (!terminal) throw new Error(`terminal ${id} is missing from the authenticated listing`);
    return terminal;
  }, terminalId);
}

async function observeRejectedBrowserSocket(page: Page, socketUrl: string): Promise<BrowserSocketOutcome> {
  return page.evaluate((target) => new Promise<BrowserSocketOutcome>((resolve) => {
    let opened = false;
    const socket = new WebSocket(target);
    socket.addEventListener("open", () => {
      opened = true;
      socket.close();
    });
    socket.addEventListener("error", () => undefined);
    socket.addEventListener("close", (event) => resolve({ opened, code: event.code, reason: event.reason }));
  }), socketUrl);
}

function nextConnectionGeneration(controller: NetworkFaultController, terminalId: string): number {
  let generation = 0;
  for (const event of controller.events) {
    if (event.terminalId !== terminalId || event.generation === undefined) continue;
    generation = Math.max(generation, event.generation);
  }
  return generation + 1;
}

async function waitForRejectedConnection(
  controller: NetworkFaultController,
  terminalId: string,
  generation: number,
): Promise<void> {
  const event = await controller.waitFor((candidate) => (
    (candidate.type === "connection-closed" || candidate.type === "connection-terminated")
    && candidate.terminalId === terminalId
    && candidate.generation === generation
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(event.type).toBe("connection-closed");
  expect(event.abrupt).toBe(false);
  const events = controller.events.filter((candidate) => (
    candidate.terminalId === terminalId && candidate.generation === generation
  ));
  expect(events.filter((candidate) => candidate.type === "upgrade-open")).toHaveLength(0);
}

function unexpectedBrowserErrors(collectors: readonly BrowserErrorCollector[]): readonly unknown[] {
  return collectors.flatMap((collector) => collector()).filter((entry) => (
    entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
}

test("E-05 Cross-origin and unauthenticated socket smoke tests @nightly @security @e", async ({
  browser,
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const extraCollectors: BrowserErrorCollector[] = [];
  let unauthenticatedContext: BrowserContext | undefined;
  let hostileContext: BrowserContext | undefined;

  try {
    const tag = runTag(testInfo);
    const readyId = `${tag}-ready`;
    const beforePrintId = `${tag}-before-print`;
    const beforeText = `${tag}-before`;
    const finalPrintId = `${tag}-final-print`;
    const finalText = `${tag}-valid-session`;
    const echoId = `${tag}-echo`;
    const inputMarker = `${tag}-continued-input`;

    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();

    const mountEvent = page.evaluate(async (timeout) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent((event) => event.type === "mount", { timeout });
    }, WAIT_TIMEOUT_MS);
    await workbench.createTerminal();
    const mounted = await mountEvent;
    const terminalId = mounted.terminalId;
    const terminal = workbench.terminal(terminalId);
    await terminal.expectVisible();
    const terminalViewport = terminal.xtermHost.locator(".xterm-screen");
    await expect(terminalViewport).toBeVisible();

    const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalConnected(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    expect(initial.activeSocketCount).toBe(1);
    expect(initial.acceptingInput).toBe(true);
    expect(initial.serverViewport?.cols).toBe(initial.cols);
    expect(initial.serverViewport?.rows).toBe(initial.rows);
    const initialInfo = await readTerminal(page, terminalId);
    expect(initialInfo.status).toBe("running");
    expect(initialInfo.pid).toBeGreaterThan(0);
    expect(initialInfo.clients).toBe(1);

    await terminal.sendInput(`READY ${readyId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "ready" && entry.id === readyId,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await terminal.sendInput(`PRINT ${beforePrintId} ${beforeText}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === beforePrintId && entry.text === beforeText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:PRINT:${beforePrintId}:${beforeText}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    const beforeSecurityPixels = await screenshotRegion(page, terminalViewport);
    await expectTerminalNonBlank(page, terminalViewport, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "e05-before-security",
    });

    unauthenticatedContext = await browser.newContext({ baseURL });
    const unauthenticatedPage = await unauthenticatedContext.newPage();
    extraCollectors.push(installBrowserErrorCollectors(unauthenticatedPage));
    await unauthenticatedPage.goto(baseURL);
    await new LoginPage(unauthenticatedPage).expectVisible();

    const unauthenticatedSocketUrl = websocketUrl(baseURL, terminalId);
    const unauthenticatedHttpUrl = httpUpgradeUrl(unauthenticatedSocketUrl);
    const unauthenticatedRawGeneration = nextConnectionGeneration(faultController, terminalId);
    const unauthenticatedRawClosed = waitForRejectedConnection(
      faultController,
      terminalId,
      unauthenticatedRawGeneration,
    );
    const unauthenticatedResponse = await unauthenticatedContext.request.get(unauthenticatedHttpUrl, {
      headers: upgradeHeaders(baseURL),
      maxRedirects: 0,
    });
    expect(unauthenticatedResponse.status()).toBe(401);
    await unauthenticatedRawClosed;

    const unauthenticatedBrowserGeneration = nextConnectionGeneration(faultController, terminalId);
    const unauthenticatedBrowserClosed = waitForRejectedConnection(
      faultController,
      terminalId,
      unauthenticatedBrowserGeneration,
    );
    const unauthenticatedOutcome = await observeRejectedBrowserSocket(
      unauthenticatedPage,
      unauthenticatedSocketUrl,
    );
    await unauthenticatedBrowserClosed;
    expect(unauthenticatedOutcome.opened).toBe(false);
    expect(unauthenticatedOutcome.code).toBe(1006);

    const afterUnauthenticated = await readTerminal(page, terminalId);
    expect(afterUnauthenticated.pid).toBe(initialInfo.pid);
    expect(afterUnauthenticated.clients).toBe(1);
    expect(afterUnauthenticated.status).toBe("running");

    const base = new URL(baseURL);
    base.hostname = "localhost";
    const hostileOrigin = base.origin;
    const hostileDomain = base.hostname;
    const validCookies = await page.context().cookies(baseURL);
    expect(validCookies.length).toBeGreaterThan(0);
    hostileContext = await browser.newContext({ baseURL: hostileOrigin });
    await hostileContext.addCookies(validCookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: hostileDomain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    })));
    const hostileCookies = await hostileContext.cookies(hostileOrigin);
    expect(hostileCookies.length).toBe(validCookies.length);
    const hostilePage = await hostileContext.newPage();
    extraCollectors.push(installBrowserErrorCollectors(hostilePage));
    await hostilePage.goto(hostileOrigin);
    expect(new URL(hostilePage.url()).origin).toBe(hostileOrigin);

    const hostileSocketUrl = websocketUrl(hostileOrigin, terminalId);
    const hostileHttpUrl = httpUpgradeUrl(hostileSocketUrl);
    const cookieHeader = hostileCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    expect(cookieHeader.length).toBeGreaterThan(0);
    const hostileRawGeneration = nextConnectionGeneration(faultController, terminalId);
    const hostileRawClosed = waitForRejectedConnection(faultController, terminalId, hostileRawGeneration);
    const hostileResponse = await hostileContext.request.get(hostileHttpUrl, {
      headers: upgradeHeaders(hostileOrigin, cookieHeader),
      maxRedirects: 0,
    });
    expect(hostileResponse.status()).toBe(403);
    await hostileRawClosed;

    const hostileBrowserGeneration = nextConnectionGeneration(faultController, terminalId);
    const hostileBrowserClosed = waitForRejectedConnection(
      faultController,
      terminalId,
      hostileBrowserGeneration,
    );
    const hostileOutcome = await observeRejectedBrowserSocket(hostilePage, hostileSocketUrl);
    await hostileBrowserClosed;
    expect(hostileOutcome.opened).toBe(false);
    expect(hostileOutcome.code).toBe(1006);

    const rejectedTranscript = await server.readTranscript(terminalId);
    expect(rejectedTranscript.filter((entry) => entry.event === "echo_input")).toHaveLength(0);
    const afterHostile = await readTerminal(page, terminalId);
    expect(afterHostile.pid).toBe(initialInfo.pid);
    expect(afterHostile.clients).toBe(1);
    expect(afterHostile.status).toBe("running");

    const beforeFinalPrint = await screenshotRegion(page, terminalViewport);
    await terminal.sendInput(`PRINT ${finalPrintId} ${finalText}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "print" && entry.id === finalPrintId && entry.text === finalText,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(page, terminalId, {
      contains: `[E2E:PRINT:${finalPrintId}:${finalText}]`,
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectKnownMarkerChanged(page, terminalViewport, beforeFinalPrint, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: "e05-final-output",
    });
    await expectTerminalNonBlank(page, terminalViewport, {
      minimumNonBackgroundRatio: 0.002,
      testInfo,
      artifactName: "e05-final-output-nonblank",
    });

    await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await terminal.sendInput(inputMarker, true);
    const inputPayload = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    expect(inputPayload.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "ready" && entry.id === readyId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === beforePrintId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "print" && entry.id === finalPrintId)).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);

    const finalSnapshot = await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS }).then(async () => {
      const snapshot = await terminal.snapshot();
      if (!snapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
      return snapshot;
    });
    expect(finalSnapshot.socketState).toBe("connected");
    expect(finalSnapshot.acceptingInput).toBe(true);
    expect(finalSnapshot.activeSocketCount).toBe(1);
    expect(finalSnapshot.socket.activeCount).toBe(1);
    expect(finalSnapshot.socketGeneration).toBe(initial.socketGeneration);
    expect(finalSnapshot.lifecycle.mounted).toBe(true);
    expect(finalSnapshot.lifecycle.visible).toBe(true);
    expect(finalSnapshot.lifecycle.acceptingInput).toBe(true);

    await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const events = await terminalEvents(page, terminalId);
    await assertMonotonicSequences(events);
    await expectTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
    const finalInfo = await readTerminal(page, terminalId);
    expect(finalInfo.pid).toBe(initialInfo.pid);
    expect(finalInfo.clients).toBe(1);

    expect(beforeSecurityPixels.width).toBeGreaterThan(0);
    expect(beforeSecurityPixels.height).toBeGreaterThan(0);
    expect(unexpectedBrowserErrors([browserErrors, ...extraCollectors])).toEqual([]);
    expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  } finally {
    for (const collector of extraCollectors) collector.dispose();
    browserErrors.dispose();
    await hostileContext?.close();
    await unauthenticatedContext?.close();
  }
});
