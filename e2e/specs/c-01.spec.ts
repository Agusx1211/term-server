import { test, expect } from "../fixtures/test.js";
import type { BrowserErrorCollector, IsolatedServer } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { Page, Route, TestInfo, BrowserContext } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
  waitForTerminalEvent,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import { expectConnectedTerminalInvariants } from "../assertions/invariants.js";
import type { E2ETerminalDiagnosticsApi, E2ETerminalEvent, E2ETerminalSnapshot } from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
  readonly createdAt: number;
  readonly clients: number;
  readonly broker?: unknown;
}

interface SizeTranscriptEntry {
  readonly [key: string]: unknown;
  readonly event: "size";
  readonly id: string;
  readonly rows: number;
  readonly cols: number;
  readonly pixel_width?: number;
  readonly pixel_height?: number;
}

interface WinchTranscriptEntry {
  readonly [key: string]: unknown;
  readonly event: "sigwinch";
  readonly signal_sequence: number;
  readonly rows: number;
  readonly cols: number;
}

interface RecoveredPath {
  readonly label: string;
  readonly page: Page;
  readonly pane: TerminalPanePage;
  readonly terminalId: string;
  readonly server: IsolatedServer;
  readonly terminalIdentity: TerminalApiInfo;
  readonly dimensions: { readonly cols: number; readonly rows: number; readonly pixelWidth: number; readonly pixelHeight: number };
  readonly retainedMarkers: readonly string[];
  readonly gate: string;
  readonly liveId: string;
  readonly liveText: string;
  readonly echoId: string;
  readonly echoText: string;
  readonly sizeId: string;
  readonly testInfo: TestInfo;
  readonly previousSequence?: number;
  readonly previousEpoch?: number;
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

async function hardReload(page: Page): Promise<void> {
  // Context routing disables the browser HTTP cache for every engine. The
  // explicit request headers also make the cache-bypass intent observable at
  // the reverse proxy while leaving the production reload path untouched.
  const bypassCache = async (route: Route): Promise<void> => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });
  };
  const context = page.context();
  await context.route("**/*", bypassCache);
  try {
    await page.reload({ waitUntil: "load" });
  } finally {
    await context.unroute("**/*", bypassCache);
  }
}

async function waitForRenderedOutput(
  page: Page,
  terminalId: string,
  minimumRenderCount: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, minimumRenderCount, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.renderCount > minimumRenderCount
      && snapshot.pendingParserWrites === 0
      && snapshot.pendingParserBytes === 0
      && snapshot.renderBacklogBytes === 0
      && snapshot.renderBacklogFrames === 0
    ), { timeout });
  }, { id: terminalId, minimumRenderCount, timeout: WAIT_TIMEOUT_MS });
}

async function waitForPostFontViewport(
  page: Page,
  terminalId: string,
  fontLoaded: E2ETerminalEvent,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, fontEventId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const aligned = (snapshot: E2ETerminalSnapshot): boolean => {
      const matchesCurrent = (viewport: E2ETerminalSnapshot["serverViewport"]): boolean => (
        viewport !== undefined
        && viewport.cols === snapshot.cols
        && viewport.rows === snapshot.rows
        && viewport.pixelWidth === snapshot.pixelWidth
        && viewport.pixelHeight === snapshot.pixelHeight
      );
      return matchesCurrent(snapshot.desiredViewport)
        && matchesCurrent(snapshot.sentViewport)
        && matchesCurrent(snapshot.serverViewport);
    };
    await api.waitForEvent(
      id,
      (event) => event.id > fontEventId && event.type === "viewport" && event.data.source === "proposed",
      { timeout },
    );
    return api.waitForTerminal(id, aligned, { timeout });
  }, { id: terminalId, fontEventId: fontLoaded.id, timeout: WAIT_TIMEOUT_MS });
}

function expectSocketLifecycle(events: readonly E2ETerminalEvent[], label: string): void {
  expect(events.filter((event) => event.type === "socket-created"), `${label} must create one socket`).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-open"), `${label} must open one socket`).toHaveLength(1);
  expect(events.filter((event) => event.type === "sync"), `${label} must synchronize once`).toHaveLength(1);
  expect(events.filter((event) => event.type === "synced"), `${label} must finish synchronization once`).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close"), `${label} must not close its current socket`).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale"), `${label} must not use a stale socket`).toHaveLength(0);
  expect(events.filter((event) => event.type === "error"), `${label} must not record a diagnostic error`).toHaveLength(0);

  const syncModes = events
    .filter((event) => event.type === "sync")
    .map((event) => event.data.mode);
  expect(syncModes[0], `${label} must begin with a snapshot`).toBe("snapshot");
  expect(syncModes.every((mode) => mode === "snapshot" || mode === "resume"), `${label} has an invalid sync mode`).toBe(true);
}

function expectIdentity(
  current: TerminalApiInfo,
  initial: TerminalApiInfo,
  label: string,
): void {
  expect(current.id, `${label} changed the terminal id`).toBe(initial.id);
  expect(current.createdAt, `${label} changed terminal creation time`).toBe(initial.createdAt);
  expect(current.status, `${label} did not retain a running terminal`).toBe("running");
  expect(current.pid, `${label} changed the fixture process identity`).toBe(initial.pid);
  expect(current.clients, `${label} must leave one attached client`).toBe(1);
  if (initial.broker !== undefined) expect(current.broker, `${label} changed broker identity`).toEqual(initial.broker);
}

async function assertFixtureGeometry(
  path: RecoveredPath,
  snapshot: E2ETerminalSnapshot,
): Promise<void> {
  await path.pane.sendInput(`SIZE ${path.sizeId}`, true);
  const size = await path.server.waitForTranscript<SizeTranscriptEntry>(
    path.terminalId,
    (entry) => entry.event === "size" && entry.id === path.sizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(size.rows, `${path.label} PTY rows disagree with xterm`).toBe(snapshot.rows);
  expect(size.cols, `${path.label} PTY columns disagree with xterm`).toBe(snapshot.cols);
  if (size.pixel_width !== undefined) expect(size.pixel_width, `${path.label} PTY pixel width disagrees`).toBe(snapshot.pixelWidth);
  if (size.pixel_height !== undefined) expect(size.pixel_height, `${path.label} PTY pixel height disagrees`).toBe(snapshot.pixelHeight);
  await expectTerminalBuffer(path.page, path.terminalId, {
    contains: `[E2E:SIZE:${path.sizeId}:${size.rows}:${size.cols}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const transcript = await path.server.readTranscript<WinchTranscriptEntry>(path.terminalId);
  const winches = transcript.filter((entry) => entry.event === "sigwinch");
  let previousSequence: number | undefined;
  for (const entry of winches) {
    expect(entry.signal_sequence, `${path.label} WINCH sequence must increase`).toBeGreaterThan(previousSequence ?? 0);
    expect(entry.rows, `${path.label} WINCH rows must be positive`).toBeGreaterThan(0);
    expect(entry.cols, `${path.label} WINCH columns must be positive`).toBeGreaterThan(0);
    previousSequence = entry.signal_sequence;
  }
  const matchingWinch = winches.find((entry) => entry.rows === snapshot.rows && entry.cols === snapshot.cols);
  if (matchingWinch) {
    expect(matchingWinch.rows).toBe(snapshot.serverViewport?.rows ?? snapshot.rows);
    expect(matchingWinch.cols).toBe(snapshot.serverViewport?.cols ?? snapshot.cols);
  }
}

async function verifyRecoveredPath(path: RecoveredPath): Promise<E2ETerminalSnapshot> {
  const synchronizedRaw = await expectTerminalSynchronized(path.page, path.terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(synchronizedRaw.socketGeneration).toBe(1);
  const fontLoaded = await waitForTerminalEvent(path.page, path.terminalId, "font-load", { timeout: WAIT_TIMEOUT_MS });
  expect(fontLoaded.data.result).toBe("settled");
  const synchronized = await waitForPostFontViewport(path.page, path.terminalId, fontLoaded);
  expect(synchronized.socketState).toBe("connected");
  expect(synchronized.socketGeneration).toBe(1);
  expect(synchronized.activeSocketCount).toBe(1);
  expect(synchronized.acceptingInput).toBe(true);
  expect(synchronized.serverViewport).toBeDefined();
  expect(synchronized.serverViewport?.cols).toBe(path.dimensions.cols);
  expect(synchronized.serverViewport?.rows).toBe(path.dimensions.rows);
  expect(synchronized.serverViewport?.pixelWidth).toBe(path.dimensions.pixelWidth);
  expect(synchronized.serverViewport?.pixelHeight).toBe(path.dimensions.pixelHeight);
  const converged = await expectTerminalConverged(path.page, path.terminalId, path.dimensions, { timeout: WAIT_TIMEOUT_MS });
  expect(converged.xterm.text).toBe(synchronized.xterm.text);
  for (const marker of path.retainedMarkers) {
    await expectTerminalBuffer(path.page, path.terminalId, { contains: marker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  }
  const recoveredInfo = await readTerminal(path.page, path.terminalId);
  expectIdentity(recoveredInfo, path.terminalIdentity, path.label);
  if (path.previousSequence !== undefined) {
    expect(synchronized.receivedSequence).toBeGreaterThanOrEqual(path.previousSequence);
    expect(synchronized.committedSequence).toBeGreaterThanOrEqual(path.previousSequence);
  }
  if (path.previousEpoch !== undefined && synchronized.gridEpoch !== undefined) {
    expect(synchronized.gridEpoch, `${path.label} regressed the terminal grid epoch`).toBeGreaterThanOrEqual(path.previousEpoch);
  }

  const beforePixels = await screenshotRegion(path.page, path.pane.xtermHost);
  await path.pane.sendInput(`RELEASE ${path.gate}`, true);
  await path.server.waitForTranscript(
    path.terminalId,
    (entry) => entry.event === "release" && entry.token === path.gate,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await path.pane.sendInput(`PRINT ${path.liveId} ${path.liveText}`, true);
  await path.server.waitForTranscript(
    path.terminalId,
    (entry) => entry.event === "print" && entry.id === path.liveId && entry.text === path.liveText,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(path.page, path.terminalId, {
    contains: `[E2E:PRINT:${path.liveId}:${path.liveText}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await waitForRenderedOutput(path.page, path.terminalId, synchronized.renderCount);
  const { after: afterPixels } = await expectKnownMarkerChanged(
    path.page,
    path.pane.xtermHost,
    beforePixels,
    {
      minimumChangedRatio: 0.002,
      testInfo: path.testInfo,
      artifactName: `c-01-${path.label}-live-marker`,
    },
  );
  expect(afterPixels.width).toBe(beforePixels.width);
  expect(afterPixels.height).toBe(beforePixels.height);
  await expectTerminalNonBlank(path.page, path.pane.xtermHost, {
    testInfo: path.testInfo,
    artifactName: `c-01-${path.label}-terminal`,
  });

  await path.pane.sendInput(`ECHO_INPUT ${path.echoId}`, true);
  await path.server.waitForTranscript(
    path.terminalId,
    (entry) => entry.event === "echo_input" && entry.id === path.echoId && entry.phase === "armed",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await path.pane.sendInput(path.echoText, true);
  const echo = await path.server.waitForTranscript<{ event: string; id: string; phase: string; payload_base64?: string }>(
    path.terminalId,
    (entry) => entry.event === "echo_input" && entry.id === path.echoId && entry.phase === "payload",
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(echo.payload_base64).toBe(Buffer.from(path.echoText, "utf8").toString("base64"));
  await expectTerminalBuffer(path.page, path.terminalId, {
    contains: `[E2E:ECHO_INPUT:${path.echoId}:${echo.payload_base64}]`,
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const final = await waitForTerminalState(path.page, path.terminalId, {
    socketState: "connected",
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(final.activeSocketCount).toBe(1);
  await expectNoPendingRecovery(path.page, path.terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalConverged(path.page, path.terminalId, path.dimensions, { timeout: WAIT_TIMEOUT_MS });
  await assertFixtureGeometry(path, final);

  const events = await terminalEvents(path.page, path.terminalId);
  expectSocketLifecycle(events, path.label);
  await assertMonotonicSequences(events);
  const invariantReport = await expectConnectedTerminalInvariants(path.page, path.terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations, `${path.label} terminal invariant violations`).toEqual([]);
  expect(final.renderCount).toBeGreaterThan(0);
  expect(final.pendingParserWrites).toBe(0);
  expect(final.pendingParserBytes).toBe(0);
  expect(final.renderBacklogBytes).toBe(0);
  expect(final.renderBacklogFrames).toBe(0);
  return final;
}

test("C-01 Soft reload, hard reload, and fresh context @p1 @nightly", async ({ browser, baseURL, page, server }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `W${testInfo.workerIndex}-P${testInfo.parallelIndex}-R${testInfo.retry}-I${testInfo.repeatEachIndex}`;
  const retainedId = `C01-${runTag}-RETAINED`;
  const retainedText = `retained-C01-${runTag}`;
  const retainedMarker = `[E2E:PRINT:${retainedId}:${retainedText}]`;
  const initialReadyId = `C01-${runTag}-READY`;
  const initialSizeId = `C01-${runTag}-INITIAL-SIZE`;
  const dimensionsMarker = (id: string, rows: number, cols: number): string => `[E2E:SIZE:${id}:${rows}:${cols}]`;

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
  const terminalId = created.id;
  const pane = new TerminalPanePage(page, terminalId, created.name);
  await pane.expectVisible();

  const synchronized = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(synchronized.socketGeneration).toBe(1);
  expect(synchronized.activeSocketCount).toBe(1);
  expect(synchronized.acceptingInput).toBe(true);
  const fontLoaded = await waitForTerminalEvent(page, terminalId, "font-load", { timeout: WAIT_TIMEOUT_MS });
  expect(fontLoaded.data.result).toBe("settled");
  const initial = await waitForPostFontViewport(page, terminalId, fontLoaded);
  const dimensions = {
    cols: initial.cols,
    rows: initial.rows,
    pixelWidth: initial.pixelWidth,
    pixelHeight: initial.pixelHeight,
  } as const;
  await expectTerminalConverged(page, terminalId, dimensions, { timeout: WAIT_TIMEOUT_MS });
  const initialTerminal = await readTerminal(page, terminalId);
  expect(initialTerminal.status).toBe("running");
  expect(initialTerminal.pid).not.toBeNull();
  expect(initialTerminal.clients).toBe(1);

  await pane.sendInput(`READY ${initialReadyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === initialReadyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await pane.sendInput(`PRINT ${retainedId} ${retainedText}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === retainedId && entry.text === retainedText, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: retainedMarker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "c-01-initial-terminal",
  });
  await pane.sendInput(`SIZE ${initialSizeId}`, true);
  const initialSize = await server.waitForTranscript<SizeTranscriptEntry>(
    terminalId,
    (entry) => entry.event === "size" && entry.id === initialSizeId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  expect(initialSize.rows).toBe(initial.rows);
  expect(initialSize.cols).toBe(initial.cols);
  expect(initialSize.pixel_width).toBe(initial.pixelWidth);
  expect(initialSize.pixel_height).toBe(initial.pixelHeight);
  await expectTerminalBuffer(page, terminalId, {
    contains: dimensionsMarker(initialSizeId, initialSize.rows, initialSize.cols),
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });

  const softGate = `C01-${runTag}-SOFT-GATE`;
  await pane.sendInput(`HOLD ${softGate}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === softGate, { timeoutMs: WAIT_TIMEOUT_MS });
  await page.reload({ waitUntil: "load" });
  await expect(page.locator(".workbench")).toBeVisible();
  const softPane = new TerminalPanePage(page, terminalId, created.name);
  await softPane.expectVisible();
  const softLiveId = `C01-${runTag}-SOFT-LIVE`;
  const softLiveText = `live-C01-soft-${runTag}`;
  const softEchoId = `C01-${runTag}-SOFT-ECHO`;
  const softEchoText = `input-C01-soft-${runTag}`;
  const softFinal = await verifyRecoveredPath({
    label: "soft-reload",
    page,
    pane: softPane,
    terminalId,
    server,
    terminalIdentity: initialTerminal,
    dimensions,
    retainedMarkers: [retainedMarker],
    gate: softGate,
    liveId: softLiveId,
    liveText: softLiveText,
    echoId: softEchoId,
    echoText: softEchoText,
    sizeId: `C01-${runTag}-SOFT-SIZE`,
    testInfo,
    previousSequence: initial.committedSequence,
    previousEpoch: initial.gridEpoch,
  });

  const hardGate = `C01-${runTag}-HARD-GATE`;
  await softPane.sendInput(`HOLD ${hardGate}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === hardGate, { timeoutMs: WAIT_TIMEOUT_MS });
  await hardReload(page);
  await expect(page.locator(".workbench")).toBeVisible();
  const hardPane = new TerminalPanePage(page, terminalId, created.name);
  await hardPane.expectVisible();
  const hardLiveId = `C01-${runTag}-HARD-LIVE`;
  const hardLiveText = `live-C01-hard-${runTag}`;
  const hardEchoId = `C01-${runTag}-HARD-ECHO`;
  const hardEchoText = `input-C01-hard-${runTag}`;
  const hardFinal = await verifyRecoveredPath({
    label: "hard-reload",
    page,
    pane: hardPane,
    terminalId,
    server,
    terminalIdentity: initialTerminal,
    dimensions,
    retainedMarkers: [retainedMarker, `[E2E:PRINT:${softLiveId}:${softLiveText}]`],
    gate: hardGate,
    liveId: hardLiveId,
    liveText: hardLiveText,
    echoId: hardEchoId,
    echoText: hardEchoText,
    sizeId: `C01-${runTag}-HARD-SIZE`,
    testInfo,
    previousSequence: softFinal.committedSequence,
    previousEpoch: softFinal.gridEpoch,
  });

  const freshGate = `C01-${runTag}-FRESH-GATE`;
  await hardPane.sendInput(`HOLD ${freshGate}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === freshGate, { timeoutMs: WAIT_TIMEOUT_MS });
  const initialViewport = page.viewportSize();
  const initialDevicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  const originalContext = page.context();
  await originalContext.close();

  let freshContext: BrowserContext | undefined;
  let freshErrors: BrowserErrorCollector | undefined;
  try {
    freshContext = await browser.newContext({
      baseURL,
      ...(initialViewport ? { viewport: initialViewport } : {}),
      deviceScaleFactor: initialDevicePixelRatio,
    });
    const freshPage = await freshContext.newPage();
    freshErrors = installBrowserErrorCollectors(freshPage);
    await freshPage.goto(baseURL);
    await new LoginPage(freshPage).login();
    const freshWorkbench = new WorkbenchPage(freshPage);
    await freshWorkbench.expectVisible();
    const freshPane = await freshWorkbench.openTerminal({ id: terminalId, name: created.name });
    await freshPane.expectVisible();
    const freshLiveId = `C01-${runTag}-FRESH-LIVE`;
    const freshLiveText = `live-C01-fresh-${runTag}`;
    const freshEchoId = `C01-${runTag}-FRESH-ECHO`;
    const freshEchoText = `input-C01-fresh-${runTag}`;
    const freshFinal = await verifyRecoveredPath({
      label: "fresh-context",
      page: freshPage,
      pane: freshPane,
      terminalId,
      server,
      terminalIdentity: initialTerminal,
      dimensions,
      retainedMarkers: [
        retainedMarker,
        `[E2E:PRINT:${softLiveId}:${softLiveText}]`,
        `[E2E:PRINT:${hardLiveId}:${hardLiveText}]`,
      ],
      gate: freshGate,
      liveId: freshLiveId,
      liveText: freshLiveText,
      echoId: freshEchoId,
      echoText: freshEchoText,
      sizeId: `C01-${runTag}-FRESH-SIZE`,
      testInfo,
      previousSequence: hardFinal.committedSequence,
      previousEpoch: hardFinal.gridEpoch,
    });

    const transcript = await server.readTranscript(terminalId);
    expect(transcript.filter((entry) => entry.event === "error"), "fixture must not record errors").toEqual([]);
    expect(transcript.filter((entry) => entry.event === "print" && [retainedId, softLiveId, hardLiveId, freshLiveId].includes(String(entry.id)))).toHaveLength(4);
    expect(transcript.filter((entry) => entry.event === "hold" && [softGate, hardGate, freshGate].includes(String(entry.token)))).toHaveLength(3);
    expect(transcript.filter((entry) => entry.event === "release" && [softGate, hardGate, freshGate].includes(String(entry.token)))).toHaveLength(3);
    for (const echoId of [softEchoId, hardEchoId, freshEchoId]) {
      expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
    }
    const finalInfo = await readTerminal(freshPage, terminalId);
    expectIdentity(finalInfo, initialTerminal, "fresh context");
    expect(finalInfo.pid).toBe(initialTerminal.pid);
    const finalEvents = await terminalEvents(freshPage, terminalId);
    await assertMonotonicSequences(finalEvents);
    expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(finalEvents.filter((event) => event.type === "state" && ["disconnected", "recovering"].includes(String(event.data.state)))).toHaveLength(0);
    expect(freshFinal.socketGeneration).toBe(1);
    expect(freshFinal.activeSocketCount).toBe(1);
    expect(freshFinal.acceptingInput).toBe(true);
    expect(freshFinal.committedSequence).toBeGreaterThanOrEqual(hardFinal.committedSequence ?? 0);
    if (hardFinal.gridEpoch !== undefined && freshFinal.gridEpoch !== undefined) {
      expect(freshFinal.gridEpoch, "fresh context regressed the terminal grid epoch").toBeGreaterThanOrEqual(hardFinal.gridEpoch);
    }

    const freshBrowserErrors = freshErrors().filter(
      (entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message),
    );
    expect(freshBrowserErrors).toEqual([]);
  } finally {
    freshErrors?.dispose();
    await freshContext?.close();
  }

  const originalBrowserErrors = browserErrors().filter(
    (entry) => entry.kind === "pageerror" || entry.kind === "console" && /^error:/i.test(entry.message),
  );
  expect(originalBrowserErrors).toEqual([]);
});
