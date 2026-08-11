import { test, expect } from "../fixtures/test.js";
import type { Page, TestInfo } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
  E2EViewport,
} from "../../src/client/lib/e2e-diagnostics.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalInteractive,
  waitForTerminalBuffer,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import { expectTerminalNonBlank } from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { IsolatedServer, TranscriptEntry } from "../fixtures/test.js";

const WAIT_TIMEOUT_MS = 15_000;
const INITIAL_VIEWPORT = { width: 1_280, height: 800 };
const QUERY_NAMES = [
  "cursor",
  "mode",
  "identity",
  "window_size",
  "window_pixels",
  "cell_pixels",
] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type QueryName = (typeof QUERY_NAMES)[number];
type QueryRequest = { readonly name: QueryName; readonly sequence: string };
type Mode = { readonly id: string; readonly apply: () => Promise<void> };

type SizeEntry = TranscriptEntry & {
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width: number;
  readonly pixel_height: number;
};

type QueryEntry = TranscriptEntry & {
  readonly id: string;
  readonly name: string;
  readonly request_base64?: string;
  readonly raw_base64?: string;
  readonly index?: number;
};

function commandBytes(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

function fixtureMarker(operation: string, id: string, value: string): string {
  return `[E2E:${operation}:${id}:${value}]`;
}

function queryRequests(): readonly QueryRequest[] {
  return [
    { name: "cursor", sequence: "\x1b[6n" },
    { name: "mode", sequence: "\x1b[?25$p" },
    { name: "identity", sequence: "\x1b[c" },
    { name: "window_size", sequence: "\x1b[18t" },
    { name: "window_pixels", sequence: "\x1b[14t" },
    { name: "cell_pixels", sequence: "\x1b[16t" },
  ];
}

function viewportOf(snapshot: E2ETerminalSnapshot): E2EViewport {
  const viewport = snapshot.serverViewport;
  if (!viewport) throw new Error("terminal has no elected server viewport");
  return viewport;
}

function sameViewport(first: E2EViewport, second: E2EViewport): boolean {
  return first.cols === second.cols
    && first.rows === second.rows
    && first.pixelWidth === second.pixelWidth
    && first.pixelHeight === second.pixelHeight;
}

async function waitForSettledViewport(page: Page, terminalId: string): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const server = snapshot.serverViewport;
      return snapshot.socketState === "connected"
        && snapshot.acceptingInput
        && snapshot.pendingParserWrites === 0
        && server !== undefined
        && snapshot.cols === server.cols
        && snapshot.rows === server.rows
        && snapshot.pixelWidth === server.pixelWidth
        && snapshot.pixelHeight === server.pixelHeight;
    }, { timeout });
  }, { id: terminalId, timeout: WAIT_TIMEOUT_MS });
}

async function terminalEventHistory(page: Page, terminalId: string): Promise<readonly E2ETerminalEvent[]> {
  return page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.events(id);
  }, terminalId);
}

async function waitForFixtureCommand(
  server: IsolatedServer,
  terminalId: string,
  operation: string,
  command: string,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, (entry) => (
    entry.event === "command"
      && entry.operation === operation
      && entry.command_base64 === commandBytes(command)
  ), { timeoutMs: WAIT_TIMEOUT_MS });
}

async function exerciseQuery(
  page: Page,
  pane: TerminalPanePage,
  server: IsolatedServer,
  terminalId: string,
  modeId: string,
): Promise<void> {
  const queryId = `V15-${modeId}-QUERY`;
  const holdId = `V15-${modeId}-HOLD`;
  const sizeId = `V15-${modeId}-SIZE`;

  const before = await waitForSettledViewport(page, terminalId);
  const beforeViewport = viewportOf(before);
  const beforeEvents = await terminalEventHistory(page, terminalId);
  const beforeParserIds = beforeEvents
    .filter((event) => event.type === "parser-commit")
    .map((event) => event.id);
  const parserCommitsBeforeQuery = beforeParserIds.length;
  const lastParserCommitBeforeQuery = Math.max(0, ...beforeParserIds);
  expect(parserCommitsBeforeQuery).toBeGreaterThan(0);

  await pane.sendInput(`HOLD ${holdId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === holdId, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });

  await pane.sendInput(`SIZE ${sizeId}`, true);
  await waitForFixtureCommand(server, terminalId, "SIZE", `SIZE ${sizeId}`);
  await pane.sendInput(`QUERY ${queryId}`, true);
  const queryCommandPromise = waitForFixtureCommand(server, terminalId, "QUERY", `QUERY ${queryId}`);

  const sizePromise = server.waitForTranscript<SizeEntry>(terminalId, (entry) => (
    entry.event === "size" && entry.id === sizeId
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  const completePromise = server.waitForTranscript(terminalId, (entry) => (
    entry.event === "query_complete" && entry.id === queryId
  ), { timeoutMs: WAIT_TIMEOUT_MS });

  await pane.sendInput(`RELEASE ${holdId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === holdId, {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await queryCommandPromise;
  const [sizeEntry, queryComplete] = await Promise.all([sizePromise, completePromise]);
  await waitForTerminalBuffer(page, terminalId, {
    contains: `[E2E:QUERY:${queryId}:COMPLETE:${QUERY_NAMES.length}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const settled = await waitForSettledViewport(page, terminalId);
  const elected = viewportOf(settled);
  expect(sameViewport(elected, beforeViewport)).toBe(true);
  expect(settled.cols).toBe(elected.cols);
  expect(settled.rows).toBe(elected.rows);
  expect(settled.serverViewport).toEqual(expect.objectContaining({
    cols: elected.cols,
    rows: elected.rows,
    pixelWidth: elected.pixelWidth,
    pixelHeight: elected.pixelHeight,
  }));
  expect(sizeEntry.rows).toBe(elected.rows);
  expect(sizeEntry.cols).toBe(elected.cols);
  expect(sizeEntry.pixel_width).toBe(elected.pixelWidth);
  expect(sizeEntry.pixel_height).toBe(elected.pixelHeight);
  expect(queryComplete.replies).toBe(QUERY_NAMES.length);

  const entries = await server.readTranscript(terminalId);
  const requests = entries
    .filter((entry): entry is QueryEntry => entry.event === "query" && entry.id === queryId);
  const replies = entries
    .filter((entry): entry is QueryEntry => entry.event === "query_reply" && entry.id === queryId);
  const expectedRequests = queryRequests();
  expect(requests).toHaveLength(expectedRequests.length);
  expect(requests.map((entry) => entry.name)).toEqual(expectedRequests.map((request) => request.name));
  expect(requests.map((entry) => entry.request_base64)).toEqual(
    expectedRequests.map((request) => Buffer.from(request.sequence, "utf8").toString("base64")),
  );
  expect(replies).toHaveLength(expectedRequests.length);
  expect(replies.map((entry) => entry.name)).toEqual(expectedRequests.map((request) => request.name));
  const expectedResponses: Record<QueryName, string> = {
    cursor: "",
    mode: "",
    identity: "",
    window_size: `\x1b[8;${elected.rows};${elected.cols}t`,
    window_pixels: `\x1b[4;${elected.pixelHeight};${elected.pixelWidth}t`,
    cell_pixels: `\x1b[6;${Math.floor(elected.pixelHeight / elected.rows)};${Math.floor(elected.pixelWidth / elected.cols)}t`,
  };
  for (const request of expectedRequests) {
    const matching = replies.filter((entry) => entry.name === request.name);
    expect(matching).toHaveLength(1);
    if (request.name === "window_size" || request.name === "window_pixels" || request.name === "cell_pixels") {
      expect(matching[0]?.raw_base64).toBe(Buffer.from(expectedResponses[request.name], "utf8").toString("base64"));
    }
  }

  // The diagnostics event history is a bounded ring buffer (MAX_EVENTS) that
  // evicts old parser-commit entries, so comparing raw counts across the query
  // is racy once the buffer fills. Compare event ids instead (monotonic and
  // unaffected by eviction): the query must produce at least one new commit.
  const parserCommitsAfterQuery = (await terminalEventHistory(page, terminalId))
    .filter((event) => event.type === "parser-commit" && event.id > lastParserCommitBeforeQuery)
    .length;
  expect(parserCommitsAfterQuery).toBeGreaterThan(0);
}

test("V-15 Window-size terminal queries @nightly @pr @p1 @resize @queries", async ({ page, server }, testInfo: TestInfo) => {
  const runTag = `${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${testInfo.repeatEachIndex}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  await page.setViewportSize(INITIAL_VIEWPORT);
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mounted = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const mount = await mounted;
  const terminalId = mount.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();

  const initial = await waitForSettledViewport(page, terminalId);
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const terminalLabel = await pane.root.getAttribute("aria-label");
  const terminalName = terminalLabel?.replace(/^Terminal\s+/, "");
  if (!terminalName) throw new Error("terminal pane did not expose an accessible name");

  const modes: readonly Mode[] = [
    { id: "baseline", apply: async () => {} },
    { id: "height", apply: async () => page.setViewportSize({ width: 1_280, height: 620 }) },
    { id: "width", apply: async () => page.setViewportSize({ width: 980, height: 620 }) },
    {
      id: "layout",
      apply: async () => {
        await workbench.openSettings();
        await workbench.closeSettings();
        await workbench.sidebar.openFileExplorer();
        await workbench.sidebar.showTerminalWorkspaces();
        await workbench.sidebar.openPreview(terminalName);
        await workbench.sidebar.closePreview();
      },
    },
    { id: "browser", apply: async () => page.setViewportSize({ width: 1_440, height: 900 }) },
    {
      id: "dpr-context",
      apply: async () => {
        const visualViewport = await page.evaluate(() => window.visualViewport);
        if (!visualViewport) throw new Error("browser does not expose a visual viewport");
        expect(await page.evaluate(() => window.devicePixelRatio)).toBeGreaterThan(0);
      },
    },
    { id: "mobile", apply: async () => page.setViewportSize({ width: 430, height: 740 }) },
    { id: "terminal-zoom", apply: async () => pane.zoomIn() },
    { id: "bounds", apply: async () => page.setViewportSize({ width: 360, height: 260 }) },
  ];

  for (const mode of modes) {
    await mode.apply();
    const settled = await waitForSettledViewport(page, terminalId);
    const viewport = viewportOf(settled);
    expect(viewport.cols).toBeGreaterThan(0);
    expect(viewport.rows).toBeGreaterThan(0);
    expect(viewport.pixelWidth).toBeGreaterThanOrEqual(0);
    expect(viewport.pixelHeight).toBeGreaterThanOrEqual(0);

    const markerId = `V15-${runTag}-${mode.id}-MARKER`;
    const markerText = `${mode.id}-rendered`;
    await pane.sendInput(`PRINT ${markerId} ${markerText}`, true);
    await server.waitForTranscript(terminalId, (entry) => (
      entry.event === "print" && entry.id === markerId && entry.text === markerText
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    await waitForTerminalBuffer(page, terminalId, {
      contains: fixtureMarker("PRINT", markerId, markerText),
      occurrences: 1,
    }, { timeout: WAIT_TIMEOUT_MS });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `v15-${runTag}-${mode.id}-terminal`,
    });

    await exerciseQuery(page, pane, server, terminalId, `${runTag}-${mode.id}`);
  }

  const echoId = `V15-${runTag}-CONTINUED-ECHO`;
  const echoPayload = `V15-${runTag}-CONTINUED-INPUT`;
  await pane.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(echoPayload, true);
  const echoEntry = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  expect(echoEntry.payload_base64).toBe(Buffer.from(echoPayload, "utf8").toString("base64"));
  await waitForTerminalBuffer(page, terminalId, {
    contains: fixtureMarker("ECHO_INPUT", echoId, Buffer.from(echoPayload, "utf8").toString("base64")),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const events = await terminalEventHistory(page, terminalId);
  await assertMonotonicSequences(events);
  expect(browserErrors).toEqual([]);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.events.filter((event) => event.type === "error")).toHaveLength(0);
  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
});
