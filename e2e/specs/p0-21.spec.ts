import { Buffer } from "node:buffer";
import type { BrowserContext, Page } from "@playwright/test";
import {
  expect,
  test,
  type IsolatedServer,
  type TranscriptEntry,
} from "../fixtures/test.js";
import type { NetworkFaultDisposer } from "../fixtures/network-faults.js";
import {
  expectNoPendingRecovery,
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

const WAIT_TIMEOUT_MS = 30_000;
const RECONNECT_UPGRADE_DELAY_MS = 5_000;
const RECONNECT_TIMEOUT_MS = 15_000;
const LIVE_TAIL_TIMEOUT_MS = 6_000;
const FLOW_BLOCK_WAIT_MS = 5_000;
const CLIENT_DRAIN_WAIT_MS = 5_000;
const FLOW_PAUSE_DEADLINE_MS = 30_000;
const ESCAPE_DELAY_MS = 7_000;
const BURST_BYTES = 262_144;
const BURST_LINE_WIDTH = 256;
const LIVE_TAIL_MINIMUM_BYTES = 64_000;
const SEED_BYTES = 524_288;
const SEED_LINE_WIDTH = 256;
const GEOMETRY_A = { width: 1_280, height: 800 };
const GEOMETRY_B = { width: 900, height: 650 };

test.use({
  serverOptions: {
    environment: {
      TERM_SERVER_E2E_FLOW_BLOCK_WAIT_MS: String(FLOW_BLOCK_WAIT_MS),
      TERM_SERVER_E2E_CLIENT_DRAIN_WAIT_MS: String(CLIENT_DRAIN_WAIT_MS),
      TERM_SERVER_E2E_FLOW_CONTROL_PAUSE_DEADLINE_MS: String(
        FLOW_PAUSE_DEADLINE_MS,
      ),
    },
  },
});

type TerminalApiInfo = {
  readonly id: string;
  readonly name: string;
};

async function createTerminal(
  page: Page,
  workbench: WorkbenchPage,
): Promise<TerminalApiInfo> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === "/api/terminals"
    );
  });
  await workbench.createTerminal();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const terminal = (await response.json()) as TerminalApiInfo;
  expect(terminal.id).not.toBe("");
  expect(terminal.name).not.toBe("");
  return terminal;
}

type SnapshotExpectation = {
  readonly activeBuffer?: "normal" | "alternate";
  readonly minGridEpoch?: number;
  readonly afterReceivedSequence?: number;
  readonly differentDimensionsFrom?: {
    readonly cols: number;
    readonly rows: number;
  };
  readonly connected?: boolean;
  readonly acceptingInput?: boolean;
  readonly zeroBacklog?: boolean;
  readonly converged?: boolean;
  readonly marker?: string;
};

async function waitForSnapshot(
  page: Page,
  terminalId: string,
  expectation: SnapshotExpectation,
  timeout: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(
    async ({ id, expectation, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(
        id,
        (snapshot) => {
          if (
            expectation.activeBuffer !== undefined &&
            snapshot.activeBuffer !== expectation.activeBuffer
          )
            return false;
          if (
            expectation.minGridEpoch !== undefined &&
            (snapshot.gridEpoch === undefined ||
              snapshot.gridEpoch <= expectation.minGridEpoch)
          )
            return false;
          if (
            expectation.afterReceivedSequence !== undefined &&
            (snapshot.receivedSequence === undefined ||
              snapshot.receivedSequence <= expectation.afterReceivedSequence)
          )
            return false;
          if (
            expectation.differentDimensionsFrom !== undefined &&
            snapshot.cols === expectation.differentDimensionsFrom.cols &&
            snapshot.rows === expectation.differentDimensionsFrom.rows
          )
            return false;
          if (
            expectation.connected === true &&
            snapshot.socketState !== "connected"
          )
            return false;
          if (expectation.acceptingInput === true && !snapshot.acceptingInput)
            return false;
          if (
            expectation.zeroBacklog === true &&
            (snapshot.pendingParserWrites !== 0 ||
              snapshot.pendingParserBytes !== 0 ||
              snapshot.renderBacklogBytes !== 0 ||
              snapshot.renderBacklogFrames !== 0)
          )
            return false;
          if (
            expectation.converged === true &&
            (snapshot.receivedSequence === undefined ||
              snapshot.receivedSequence !== snapshot.committedSequence)
          )
            return false;
          if (expectation.marker !== undefined) {
            const text = snapshot.xterm.text
              .replaceAll("\n", "")
              .replaceAll("\r", "");
            const marker = expectation.marker
              .replaceAll("\n", "")
              .replaceAll("\r", "");
            if (!text.includes(marker)) return false;
          }
          return true;
        },
        { timeout },
      );
    },
    { id: terminalId, expectation, timeout },
  );
}

async function waitForTranscript(
  server: IsolatedServer,
  terminalId: string,
  predicate: (entry: TranscriptEntry) => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(terminalId, predicate, { timeoutMs });
}

function latestConnectionGeneration(
  events: readonly {
    readonly type: string;
    readonly terminalId?: string;
    readonly generation?: number;
  }[],
  terminalId: string,
): number {
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === "connection-open" &&
        candidate.terminalId === terminalId,
    );
  if (event?.generation === undefined)
    throw new Error(`terminal ${terminalId} has no open proxy connection`);
  return event.generation;
}

function compact(text: string): string {
  return text.replaceAll("\n", "").replaceAll("\r", "");
}

async function expectAtBottom(
  pane: TerminalPanePage,
  snapshot: E2ETerminalSnapshot,
): Promise<void> {
  expect(snapshot.xterm.viewportY).toBe(snapshot.xterm.baseY);
  const scrollbar = await pane.xtermHost
    .locator(".xterm-viewport")
    .evaluate((element) => {
      const viewport = element as HTMLElement;
      return {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      };
    });
  expect(scrollbar.scrollTop + scrollbar.clientHeight).toBeGreaterThanOrEqual(
    scrollbar.scrollHeight - 1,
  );
}

test("P0-21 Attach snapshot clears flow debt before live tail @p0", async ({
  browser,
  page,
  baseURL,
  server,
  faultController,
}, testInfo) => {
  await page.setViewportSize(GEOMETRY_A);
  const runTag = `W${testInfo.workerIndex}R${testInfo.retry}I${testInfo.repeatEachIndex}`;
  const seedId = `P021_SEED_${runTag}`;
  const altId = `P021_ALT_${runTag}`;
  const escapeId = `P021_ESCAPE_${runTag}`;
  const altBurstId = `P021_ALT_BURST_${runTag}`;
  const altExitId = `P021_ALT_EXIT_${runTag}`;
  const finalId = `P021_FINAL_${runTag}`;
  const finalText = `P021-FINAL-${runTag}`;
  const finalMarker = `[E2E:PRINT:${finalId}:${finalText}]`;

  let peerContext: BrowserContext | undefined;
  let pausePrimary: NetworkFaultDisposer | undefined;
  let delayReconnect: NetworkFaultDisposer | undefined;
  let delayRetry: NetworkFaultDisposer | undefined;
  let terminatePrimary: NetworkFaultDisposer | undefined;
  try {
    await page.goto(baseURL);
    await new LoginPage(page).login();
    const workbench = new WorkbenchPage(page);
    await workbench.expectVisible();
    const created = await createTerminal(page, workbench);
    const pane = new TerminalPanePage(page, created.id, created.name);
    await pane.expectVisible();
    const initial = await pane.waitForSynchronized({
      timeout: WAIT_TIMEOUT_MS,
    });
    if (initial.gridEpoch === undefined)
      throw new Error("initial terminal did not expose a grid epoch");
    const initialGeneration = latestConnectionGeneration(
      faultController.events,
      created.id,
    );

    await pane.sendInput(
      `BURST ${seedId} ${SEED_BYTES} ${SEED_LINE_WIDTH}`,
      true,
    );
    await waitForTranscript(
      server,
      created.id,
      (entry) =>
        entry.event === "burst" &&
        entry.id === seedId &&
        entry.bytes === SEED_BYTES,
    );
    await pane.sendInput(`ALT_ENTER ${altId}`, true);
    await waitForTranscript(
      server,
      created.id,
      (entry) => entry.event === "alt_enter" && entry.id === altId,
    );
    await waitForSnapshot(
      page,
      created.id,
      { activeBuffer: "alternate" },
      WAIT_TIMEOUT_MS,
    );

    peerContext = await browser.newContext({ baseURL, viewport: GEOMETRY_A });
    const peerPage = await peerContext.newPage();
    await peerPage.goto(baseURL);
    await new LoginPage(peerPage).login();
    const peerWorkbench = new WorkbenchPage(peerPage);
    await peerWorkbench.expectVisible();
    const peerPane = await peerWorkbench.openTerminal({
      id: created.id,
      name: created.name,
    });
    await peerPane.expectVisible();
    const peerInitial = await peerPane.waitForSynchronized({
      timeout: WAIT_TIMEOUT_MS,
    });
    const peerGeneration = latestConnectionGeneration(
      faultController.events,
      created.id,
    );
    const pausedPromise = faultController.waitFor(
      (event) =>
        event.type === "paused" &&
        event.terminalId === created.id &&
        event.generation === initialGeneration &&
        event.direction === "server-to-browser",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    pausePrimary = faultController.pause("server-to-browser", {
      terminalId: created.id,
      generation: initialGeneration,
    });
    await pausedPromise;

    const resizedPromise = waitForSnapshot(
      peerPage,
      created.id,
      {
        minGridEpoch: peerInitial.gridEpoch ?? 0,
        differentDimensionsFrom: {
          cols: peerInitial.cols,
          rows: peerInitial.rows,
        },
      },
      WAIT_TIMEOUT_MS,
    );
    await peerPage.setViewportSize(GEOMETRY_B);
    await peerPane.focusSize();
    const resized = await resizedPromise;
    if (resized.gridEpoch === undefined || !resized.serverViewport)
      throw new Error("peer resize did not expose a new terminal epoch");
    expect(resized.gridEpoch).toBeGreaterThan(initial.gridEpoch);
    await waitForTranscript(
      server,
      created.id,
      (entry) =>
        entry.event === "sigwinch" &&
        entry.source === "signal" &&
        entry.rows === resized.serverViewport?.rows &&
        entry.cols === resized.serverViewport?.cols,
    );
    const stalePrimary = await pane.snapshot();
    const staleSequence = stalePrimary?.receivedSequence;
    if (staleSequence === undefined)
      throw new Error("paused terminal did not expose its sequence");

    const peerClosed = faultController.waitFor(
      (event) =>
        (event.type === "connection-closed" ||
          event.type === "connection-terminated") &&
        event.terminalId === created.id &&
        event.generation === peerGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const peer = peerContext;
    if (!peer) throw new Error("peer context disappeared before cleanup");
    await peer.close();
    peerContext = undefined;
    await peerClosed;

    const escapePrefix = waitForTranscript(
      server,
      created.id,
      (entry) =>
        entry.event === "escape_delay" &&
        entry.id === escapeId &&
        entry.phase === "prefix" &&
        entry.delay_ms === ESCAPE_DELAY_MS,
    );
    await pane.sendInput(
      `ESCAPE_DELAY ${escapeId} CSI_31M 2 ${ESCAPE_DELAY_MS}`,
      true,
    );
    await escapePrefix;
    const altBurst = waitForTranscript(
      server,
      created.id,
      (entry) =>
        entry.event === "burst" &&
        entry.id === altBurstId &&
        entry.bytes === BURST_BYTES,
    );
    const altExit = waitForTranscript(
      server,
      created.id,
      (entry) => entry.event === "alt_exit" && entry.id === altExitId,
    );
    const finalPrint = waitForTranscript(
      server,
      created.id,
      (entry) =>
        entry.event === "print" &&
        entry.id === finalId &&
        entry.text === finalText,
    );
    await pane.sendInput(
      `BURST ${altBurstId} ${BURST_BYTES} ${BURST_LINE_WIDTH}`,
      true,
    );
    await pane.sendInput(`ALT_EXIT ${altExitId}`, true);
    await pane.sendInput(`PRINT ${finalId} ${finalText}`, true);
    const reconnectDelayed = faultController.waitFor(
      (event) =>
        event.type === "upgrade-delay" && event.terminalId === created.id,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    delayReconnect = faultController.delayUpgrade(
      { terminalId: created.id },
      RECONNECT_UPGRADE_DELAY_MS,
    );

    const reconnectFloor = (await pane.events()).at(-1)?.id ?? 0;
    const oldSocketClosed = pane.waitForEvent("socket-close", {
      afterId: reconnectFloor,
      timeout: WAIT_TIMEOUT_MS,
    });
    const oldConnectionClosed = faultController.waitFor(
      (event) =>
        (event.type === "connection-closed" ||
          event.type === "connection-terminated") &&
        event.terminalId === created.id &&
        event.generation === initialGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    terminatePrimary = faultController.terminate({
      terminalId: created.id,
      generation: initialGeneration,
    });
    await Promise.all([oldSocketClosed, oldConnectionClosed, reconnectDelayed]);
    terminatePrimary.dispose();
    terminatePrimary = undefined;
    pausePrimary.dispose();
    pausePrimary = undefined;

    const reconnectOpen = faultController.waitFor(
      (event) =>
        event.type === "connection-open" &&
        event.terminalId === created.id &&
        event.generation !== undefined &&
        event.generation > initialGeneration,
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    const reconnectSynced = pane.waitForEvent("synced", {
      afterId: reconnectFloor,
      timeout: RECONNECT_TIMEOUT_MS,
    });
    const firstBoundary = Promise.race([
      altBurst.then(() => "burst" as const),
      reconnectSynced.then(() => "synced" as const),
    ]);
    const reconnect = await reconnectOpen;
    delayRetry = faultController.delayUpgrade(
      { terminalId: created.id },
      WAIT_TIMEOUT_MS,
    );
    delayReconnect.dispose();
    delayReconnect = undefined;
    if (reconnect.generation === undefined)
      throw new Error("reconnect did not expose a generation");
    expect(await firstBoundary).toBe("burst");
    await altBurst;
    const synced = await reconnectSynced;
    const synchronizedAt = Date.now();
    delayRetry.dispose();
    delayRetry = undefined;
    expect(synced.snapshot.xterm.activeBuffer).toBe("alternate");
    const syncSequence = synced.snapshot.receivedSequence;
    if (syncSequence === undefined)
      throw new Error("snapshot sync did not expose its sequence");
    expect(syncSequence).toBeLessThan(staleSequence + BURST_BYTES);
    const liveTailTarget = syncSequence + LIVE_TAIL_MINIMUM_BYTES;
    await waitForSnapshot(
      page,
      created.id,
      { afterReceivedSequence: liveTailTarget - 1 },
      FLOW_PAUSE_DEADLINE_MS + WAIT_TIMEOUT_MS,
    );
    expect(
      Date.now() - synchronizedAt,
      "snapshot recovery must resume the live tail without waiting for the flow watchdog",
    ).toBeLessThan(LIVE_TAIL_TIMEOUT_MS);

    const eventsAfterReconnect = await terminalEvents(page, created.id);
    const reconnectSync = eventsAfterReconnect.find(
      (event) =>
        event.type === "sync" &&
        event.data.generation === synced.snapshot.socketGeneration,
    );
    if (!reconnectSync)
      throw new Error("reconnect did not produce a diagnostic sync event");
    expect(reconnectSync.data.mode).toBe("snapshot");
    expect(reconnectSync.data.epoch).toBeGreaterThanOrEqual(resized.gridEpoch);
    expect(reconnectSync.snapshot.gridEpoch).toBe(reconnectSync.data.epoch);

    await Promise.all([altExit, finalPrint]);
    await expectTerminalBuffer(
      page,
      created.id,
      { contains: finalMarker, occurrences: 1 },
      { timeout: WAIT_TIMEOUT_MS },
    );

    const final = await waitForSnapshot(
      page,
      created.id,
      {
        connected: true,
        acceptingInput: true,
        zeroBacklog: true,
        converged: true,
        marker: finalMarker,
      },
      WAIT_TIMEOUT_MS,
    );
    expect(final.receivedSequence).toBe(final.committedSequence);
    expect(final.stream.receivedSequence).toBe(final.stream.committedSequence);
    expect(final.pendingParserWrites).toBe(0);
    expect(final.pendingParserBytes).toBe(0);
    expect(final.renderBacklogBytes).toBe(0);
    expect(final.renderBacklogFrames).toBe(0);
    expect(final.renderBacklogOldestAgeMs).toBe(0);
    await expectNoPendingRecovery(page, created.id, {
      timeout: WAIT_TIMEOUT_MS,
    });
    await expectAtBottom(pane, final);
    expect(final.xterm.activeBuffer).toBe("normal");
    expect(compact(final.xterm.text)).toContain(compact(finalMarker));
  } finally {
    delayReconnect?.dispose();
    delayRetry?.dispose();
    terminatePrimary?.dispose();
    pausePrimary?.dispose();
    faultController.reset();
    await peerContext?.close();
  }
});
