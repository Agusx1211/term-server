import { test, expect } from "../fixtures/test.js";
import type { Page, TestInfo } from "@playwright/test";
import type { TranscriptEntry } from "../fixtures/test.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalInteractive,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertNoUnexpectedSocketMultiplication,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;
const INITIAL_VIEWPORT = { width: 1_280, height: 800 } as const;
const RESIZE_STEPS = [
  { label: "narrow", width: 1_000, height: 450 },
  { label: "wide", width: 1_800, height: 1_100 },
  { label: "short", width: 1_100, height: 320 },
  { label: "tall", width: 1_100, height: 1_400 },
] as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type Rect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

type LayoutSnapshot = {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly boxes: Record<string, Rect>;
};

type CommandResult = {
  readonly entry: TranscriptEntry;
  readonly beforeEventId: number;
};

function numericField(entry: TranscriptEntry, field: string): number | undefined {
  const value = entry[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function transcriptBoundary(entries: readonly TranscriptEntry[]): number {
  return entries.reduce((maximum, entry) => Math.max(maximum, numericField(entry, "sequence") ?? 0), 0);
}

function eventBoundary(events: readonly E2ETerminalEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.id), -1);
}

async function waitForProposedViewport(
  page: Page,
  terminalId: string,
  afterEventId: number,
  width: number,
  height: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, width: expectedWidth, height: expectedHeight, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === "viewport"
      && event.data.source === "proposed"
      && typeof event.data.cols === "number"
      && typeof event.data.rows === "number"
      && window.innerWidth === expectedWidth
      && window.innerHeight === expectedHeight
    ), { timeout, afterId: after });
  }, { id: terminalId, after: afterEventId, width, height, timeout: WAIT_TIMEOUT_MS });
}

async function waitForSettledViewport(
  page: Page,
  terminalId: string,
  previous: Pick<E2ETerminalSnapshot, "cols" | "rows" | "pixelWidth" | "pixelHeight">,
  width: number,
  height: number,
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, previous, width: expectedWidth, height: expectedHeight, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => {
      const desired = snapshot.desiredViewport;
      const server = snapshot.serverViewport;
      if (!desired || !server) return false;
      const changed = snapshot.cols !== previous.cols
        || snapshot.rows !== previous.rows
        || snapshot.pixelWidth !== previous.pixelWidth
        || snapshot.pixelHeight !== previous.pixelHeight;
      return window.innerWidth === expectedWidth
        && window.innerHeight === expectedHeight
        && changed
        && snapshot.socketState === "connected"
        && snapshot.cols === desired.cols
        && snapshot.rows === desired.rows
        && snapshot.pixelWidth === desired.pixelWidth
        && snapshot.pixelHeight === desired.pixelHeight
        && snapshot.sentViewport?.cols === desired.cols
        && snapshot.sentViewport?.rows === desired.rows
        && snapshot.sentViewport?.pixelWidth === desired.pixelWidth
        && snapshot.sentViewport?.pixelHeight === desired.pixelHeight
        && server.cols === desired.cols
        && server.rows === desired.rows
        && server.pixelWidth === desired.pixelWidth
        && server.pixelHeight === desired.pixelHeight
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0;
    }, { timeout });
  }, { id: terminalId, previous, width, height, timeout: WAIT_TIMEOUT_MS });
}

async function waitForEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEvent["type"],
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => event.id > after && event.type === eventType, { timeout, afterId: after });
  }, { id: terminalId, after: afterEventId, eventType: type, timeout: WAIT_TIMEOUT_MS });
}

async function runCommand(
  page: Page,
  server: { readTranscript<T extends TranscriptEntry = TranscriptEntry>(terminalId: string): Promise<T[]>; waitForTranscript<T extends TranscriptEntry = TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean, options?: { timeoutMs?: number }): Promise<T> },
  pane: TerminalPanePage,
  terminalId: string,
  command: string,
  event: string,
  predicate: (entry: TranscriptEntry) => boolean,
  marker: string,
): Promise<CommandResult> {
  const [beforeTranscript, beforeEvents] = await Promise.all([
    server.readTranscript(terminalId),
    pane.events(),
  ]);
  const boundary = transcriptBoundary(beforeTranscript);
  const beforeEventId = eventBoundary(beforeEvents);
  const transcript = server.waitForTranscript(
    terminalId,
    (entry) => (numericField(entry, "sequence") ?? 0) > boundary && entry.event === event && predicate(entry),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await pane.sendInput(command, true);
  const entry = await transcript;
  await expectTerminalBuffer(page, terminalId, { contains: marker, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  return { entry, beforeEventId };
}

async function readLayout(page: Page, terminalId: string): Promise<LayoutSnapshot> {
  return page.evaluate((id) => {
    const terminal = [...document.querySelectorAll<HTMLElement>("[data-terminal-id]")]
      .find((candidate) => candidate.getAttribute("data-terminal-id") === id);
    if (!terminal) throw new Error(`Terminal ${id} is not mounted in the layout`);
    const slot = terminal.closest<HTMLElement>(".pane-slot");
    const elements: Record<string, HTMLElement | null> = {
      app: document.querySelector<HTMLElement>("#app"),
      workbench: document.querySelector<HTMLElement>(".workbench"),
      workbenchMain: document.querySelector<HTMLElement>(".workbench-main"),
      workspaceArea: document.querySelector<HTMLElement>(".workspace-area"),
      workspaceStage: document.querySelector<HTMLElement>(".workspace-stage"),
      editorGrid: document.querySelector<HTMLElement>(".editor-grid"),
      paneSlot: slot,
      terminalPane: terminal,
      terminalBody: terminal.querySelector<HTMLElement>(".terminal-body"),
      xtermHost: terminal.querySelector<HTMLElement>(".xterm-host"),
      xtermScreen: terminal.querySelector<HTMLElement>(".xterm-screen"),
      statusbar: document.querySelector<HTMLElement>("footer.statusbar"),
    };
    const boxes = Object.fromEntries(Object.entries(elements).map(([name, element]) => {
      if (!element) throw new Error(`Missing layout element ${name}`);
      const rect = element.getBoundingClientRect();
      return [name, {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      } satisfies Rect];
    })) as Record<string, Rect>;
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, boxes };
  }, terminalId);
}

function assertLayoutWithinViewport(layout: LayoutSnapshot, expected: { readonly width: number; readonly height: number }): void {
  const epsilon = 1;
  expect(layout.innerWidth).toBe(expected.width);
  expect(layout.innerHeight).toBe(expected.height);
  const boxes = layout.boxes;
  for (const [name, rect] of Object.entries(boxes)) {
    expect(rect.width, `${name} has no width`).toBeGreaterThan(0);
    expect(rect.height, `${name} has no height`).toBeGreaterThan(0);
    expect(rect.left, `${name} is clipped on the left`).toBeGreaterThanOrEqual(-epsilon);
    expect(rect.top, `${name} is clipped on the top`).toBeGreaterThanOrEqual(-epsilon);
    expect(rect.right, `${name} is clipped on the right`).toBeLessThanOrEqual(expected.width + epsilon);
    expect(rect.bottom, `${name} is clipped on the bottom`).toBeLessThanOrEqual(expected.height + epsilon);
  }
  const containment: readonly (readonly [string, string])[] = [
    ["workbench", "app"],
    ["workbenchMain", "workbench"],
    ["workspaceArea", "workbenchMain"],
    ["workspaceStage", "workspaceArea"],
    ["editorGrid", "workspaceStage"],
    ["paneSlot", "editorGrid"],
    ["terminalPane", "paneSlot"],
    ["terminalBody", "terminalPane"],
    ["xtermHost", "terminalBody"],
    ["xtermScreen", "xtermHost"],
    ["statusbar", "app"],
  ];
  for (const [childName, parentName] of containment) {
    const child = boxes[childName]!;
    const parent = boxes[parentName]!;
    expect(child.left, `${childName} escapes ${parentName} on the left`).toBeGreaterThanOrEqual(parent.left - epsilon);
    expect(child.top, `${childName} escapes ${parentName} on the top`).toBeGreaterThanOrEqual(parent.top - epsilon);
    expect(child.right, `${childName} escapes ${parentName} on the right`).toBeLessThanOrEqual(parent.right + epsilon);
    expect(child.bottom, `${childName} escapes ${parentName} on the bottom`).toBeLessThanOrEqual(parent.bottom + epsilon);
  }
  expect(Math.abs(boxes.statusbar!.height - 22), "desktop statusbar height changed during resize").toBeLessThanOrEqual(epsilon);
}

async function waitForPtySignal(
  server: { waitForTranscript<T extends TranscriptEntry = TranscriptEntry>(terminalId: string, predicate: (entry: TranscriptEntry, entries: readonly TranscriptEntry[]) => boolean, options?: { timeoutMs?: number }): Promise<T> },
  terminalId: string,
  boundary: number,
  rows: number,
  cols: number,
): Promise<TranscriptEntry> {
  return server.waitForTranscript(
    terminalId,
    (entry) => (
      (numericField(entry, "sequence") ?? 0) > boundary
      && entry.event === "sigwinch"
      && entry.source === "signal"
      && numericField(entry, "rows") === rows
      && numericField(entry, "cols") === cols
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

test("V-10 Browser window resize @p1 @resize @nightly", async ({ page, server }, testInfo: TestInfo) => {
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

  const mountEvent = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(initial.cols).toBeGreaterThan(0);
  expect(initial.rows).toBeGreaterThan(0);
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);

  const token = `V10-${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const readyId = `${token}-READY`;
  await runCommand(
    page,
    server,
    pane,
    terminalId,
    `READY ${readyId}`,
    "ready",
    (entry) => entry.id === readyId,
    `[E2E:READY:${readyId}]`,
  );

  const snapshots: E2ETerminalSnapshot[] = [initial];
  let previous = initial;
  for (let index = 0; index < RESIZE_STEPS.length; index += 1) {
    const step = RESIZE_STEPS[index]!;
    const [beforeEvents, beforeTranscript] = await Promise.all([
      pane.events(),
      server.readTranscript(terminalId),
    ]);
    const beforeEventId = eventBoundary(beforeEvents);
    const transcriptFloor = transcriptBoundary(beforeTranscript);
    const proposed = waitForProposedViewport(page, terminalId, beforeEventId, step.width, step.height);
    await workbench.setViewport(step.width, step.height);
    const proposedEvent = await proposed;
    expect(proposedEvent.data.source).toBe("proposed");
    const settled = await waitForSettledViewport(page, terminalId, previous, step.width, step.height);
    const desired = settled.desiredViewport;
    if (!desired) throw new Error(`No desired viewport was recorded for ${step.label} resize`);
    const converged = await expectTerminalConverged(page, terminalId, {
      cols: desired.cols,
      rows: desired.rows,
      pixelWidth: desired.pixelWidth,
      pixelHeight: desired.pixelHeight,
    }, { timeout: WAIT_TIMEOUT_MS });
    const expectedViewport = {
      cols: desired.cols,
      rows: desired.rows,
      pixelWidth: desired.pixelWidth,
      pixelHeight: desired.pixelHeight,
    };
    expect(converged.proposedViewport).toMatchObject(expectedViewport);
    expect(converged.desiredViewport).toMatchObject(expectedViewport);
    expect(converged.sentViewport).toMatchObject(expectedViewport);
    expect(converged.serverViewport).toMatchObject(expectedViewport);
    expect(converged.viewport).toMatchObject(expectedViewport);
    expect(converged.cols).toBe(desired.cols);
    expect(converged.rows).toBe(desired.rows);
    expect(converged.pixelWidth).toBe(desired.pixelWidth);
    expect(converged.pixelHeight).toBe(desired.pixelHeight);
    expect(converged.socketState).toBe("connected");
    expect(converged.activeSocketCount).toBe(1);
    expect(converged.acceptingInput).toBe(true);
    expect(converged.pendingParserWrites).toBe(0);
    expect(converged.pendingParserBytes).toBe(0);
    expect(converged.renderBacklogBytes).toBe(0);
    const signal = await waitForPtySignal(server, terminalId, transcriptFloor, converged.rows, converged.cols);
    expect(numericField(signal, "rows")).toBe(converged.rows);
    expect(numericField(signal, "cols")).toBe(converged.cols);
    const layout = await readLayout(page, terminalId);
    assertLayoutWithinViewport(layout, step);
    const screenBox = layout.boxes.xtermScreen!;
    expect(Math.abs(converged.pixelWidth - screenBox.width), `${step.label} CSS width disagrees with diagnostics`).toBeLessThanOrEqual(1);
    expect(Math.abs(converged.pixelHeight - screenBox.height), `${step.label} CSS height disagrees with diagnostics`).toBeLessThanOrEqual(1);

    const sizeId = `${token}-${step.label}-SIZE`;
    const size = await runCommand(
      page,
      server,
      pane,
      terminalId,
      `SIZE ${sizeId}`,
      "size",
      (entry) => entry.id === sizeId,
      `[E2E:SIZE:${sizeId}:${converged.rows}:${converged.cols}]`,
    );
    expect(numericField(size.entry, "rows")).toBe(converged.rows);
    expect(numericField(size.entry, "cols")).toBe(converged.cols);
    expect(numericField(size.entry, "pixel_width")).toBe(converged.pixelWidth);
    expect(numericField(size.entry, "pixel_height")).toBe(converged.pixelHeight);

    const winchId = `${token}-${step.label}-WINCH`;
    const winch = await runCommand(
      page,
      server,
      pane,
      terminalId,
      `WINCH ${winchId} ${index + 1} ${converged.rows} ${converged.cols}`,
      "sigwinch",
      (entry) => entry.id === winchId && entry.source === "command",
      `[E2E:WINCH:${winchId}:${index + 1}:${converged.rows}:${converged.cols}]`,
    );
    expect(numericField(winch.entry, "rows")).toBe(converged.rows);
    expect(numericField(winch.entry, "cols")).toBe(converged.cols);
    expect(numericField(winch.entry, "actual_rows")).toBe(converged.rows);
    expect(numericField(winch.entry, "actual_cols")).toBe(converged.cols);

    const queryId = `${token}-${step.label}-QUERY`;
    await runCommand(
      page,
      server,
      pane,
      terminalId,
      `QUERY ${queryId}`,
      "query_complete",
      (entry) => entry.id === queryId && numericField(entry, "replies") === 4,
      `[E2E:QUERY:${queryId}:COMPLETE:4]`,
    );
    const queryEntries = await server.readTranscript(terminalId);
    expect(queryEntries.filter((entry) => entry.event === "query_reply" && entry.id === queryId)).toHaveLength(4);

    const printId = `${token}-${step.label}-PRINT`;
    const printText = `${token}-${step.label}-W${converged.cols}`;
    const beforePixels = await screenshotRegion(page, pane.xtermHost);
    const print = await runCommand(
      page,
      server,
      pane,
      terminalId,
      `PRINT ${printId} ${printText}`,
      "print",
      (entry) => entry.id === printId && entry.text === printText,
      `[E2E:PRINT:${printId}:${printText}]`,
    );
    await waitForEventAfter(page, terminalId, print.beforeEventId, "render");
    const marker = `[E2E:PRINT:${printId}:${printText}]`;
    const printed = await pane.snapshot();
    if (!printed) throw new Error(`No snapshot after ${step.label} marker`);
    expect(printed.xterm.text).toContain(marker);
    expect(printed.xterm.text.split(marker).length - 1).toBe(1);
    await expectKnownMarkerChanged(page, pane.xtermHost, beforePixels, {
      minimumChangedRatio: 0.002,
      testInfo,
      artifactName: `v10-${step.label}-marker-crop`,
    });
    await expectTerminalNonBlank(page, pane.xtermHost, {
      testInfo,
      artifactName: `v10-${step.label}-terminal-crop`,
    });
    assertLayoutWithinViewport(await readLayout(page, terminalId), step);
    snapshots.push(printed);
    previous = printed;
  }

  const final = snapshots.at(-1);
  if (!final) throw new Error(`No final snapshot for terminal ${terminalId}`);
  const finalDesired = final.desiredViewport;
  if (!finalDesired) throw new Error(`No final desired viewport for terminal ${terminalId}`);
  const finalConverged = await expectTerminalConverged(page, terminalId, {
    cols: finalDesired.cols,
    rows: finalDesired.rows,
    pixelWidth: finalDesired.pixelWidth,
    pixelHeight: finalDesired.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  const finalExpectedViewport = {
    cols: finalDesired.cols,
    rows: finalDesired.rows,
    pixelWidth: finalDesired.pixelWidth,
    pixelHeight: finalDesired.pixelHeight,
  };
  expect(finalConverged.cols).toBe(finalExpectedViewport.cols);
  expect(finalConverged.rows).toBe(finalExpectedViewport.rows);
  expect(finalConverged.pixelWidth).toBe(finalExpectedViewport.pixelWidth);
  expect(finalConverged.pixelHeight).toBe(finalExpectedViewport.pixelHeight);
  expect(finalConverged.serverViewport).toMatchObject(finalExpectedViewport);
  expect(finalConverged.desiredViewport).toMatchObject(finalExpectedViewport);
  expect(finalConverged.sentViewport).toMatchObject(finalExpectedViewport);

  const echoId = `${token}-ECHO`;
  const echoPayload = `${token}-CONTINUED-INPUT`;
  await runCommand(
    page,
    server,
    pane,
    terminalId,
    `ECHO_INPUT ${echoId}`,
    "echo_input",
    (entry) => entry.id === echoId && entry.phase === "armed",
    `[E2E:ECHO_INPUT:${echoId}:READY]`,
  );
  const payloadBase64 = Buffer.from(echoPayload, "utf8").toString("base64");
  const payload = await runCommand(
    page,
    server,
    pane,
    terminalId,
    echoPayload,
    "echo_input",
    (entry) => entry.id === echoId && entry.phase === "payload",
    `[E2E:ECHO_INPUT:${echoId}:${payloadBase64}]`,
  );
  expect(payload.entry.payload_base64).toBe(payloadBase64);
  await expectTerminalInteractive(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const settledFinal = await expectTerminalConverged(page, terminalId, {
    cols: finalConverged.cols,
    rows: finalConverged.rows,
    pixelWidth: finalConverged.pixelWidth,
    pixelHeight: finalConverged.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(settledFinal.xterm.text).toContain(`[E2E:ECHO_INPUT:${echoId}:${payloadBase64}]`);
  expect(settledFinal.xterm.text.split(`[E2E:ECHO_INPUT:${echoId}:${payloadBase64}]`).length - 1).toBe(1);

  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const invariantReport = await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(invariantReport.violations).toEqual([]);
  await assertMonotonicSequences(await terminalEvents(page, terminalId));
  const events = await terminalEvents(page, terminalId);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-created")).toHaveLength(1);
  expect(events.filter((event) => event.type === "socket-close")).toHaveLength(0);
  expect(events.filter((event) => event.type === "socket-stale")).toHaveLength(0);
  assertNoUnexpectedSocketMultiplication(snapshots);
  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);
  expect(transcript.filter((entry) => entry.event === "sigwinch" && entry.source === "signal").length).toBeGreaterThanOrEqual(RESIZE_STEPS.length);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(browserErrors).toEqual([]);
  expect(server.stderr).not.toMatch(/(?:panic(?:ked)?|unhandled|fatal error)/i);
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "v10-final-terminal-crop",
  });
  assertLayoutWithinViewport(await readLayout(page, terminalId), RESIZE_STEPS.at(-1)!);
});
