import { expect, type Page } from "@playwright/test";
import type {
  E2EWaitOptions,
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalEventType,
  E2ETerminalSnapshot,
} from "../../src/client/lib/e2e-diagnostics.js";

export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
  readonly pixelWidth?: number;
  readonly pixelHeight?: number;
}

export interface TerminalBufferExpectation {
  readonly contains?: string;
  readonly equals?: string;
  readonly matches?: RegExp;
  readonly occurrences?: number;
}

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};


const comparableText = (text: string, contains: string): string => (
  contains.includes("\n") || text.includes(contains) ? text : text.replaceAll("\n", "")
);


export async function terminalSnapshot(
  page: Page,
  terminalId: string,
  paneId?: string,
): Promise<E2ETerminalSnapshot | undefined> {
  return page.evaluate(({ id, pane }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id, pane);
  }, { id: terminalId, pane: paneId });
}

export async function terminalEvents(
  page: Page,
  terminalId?: string,
  paneId?: string,
): Promise<readonly E2ETerminalEvent[]> {
  return page.evaluate(({ id, pane }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.events(id, pane);
  }, { id: terminalId, pane: paneId });
}

export async function waitForTerminalState(
  page: Page,
  terminalId: string,
  expected: Partial<E2ETerminalSnapshot>,
  options: E2EWaitOptions = {},
): Promise<E2ETerminalSnapshot> {
  return page.evaluate(async ({ id, expected, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, expected, { timeout });
  }, { id: terminalId, expected, timeout: options.timeout });
}

export async function waitForTerminalEvent(
  page: Page,
  terminalId: string,
  event: E2ETerminalEventType,
  options: E2EWaitOptions = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, event, timeout, afterId }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, event, { timeout, afterId });
  }, { id: terminalId, event, timeout: options.timeout, afterId: options.afterId });
}

export async function waitForTerminalBuffer(
  page: Page,
  terminalId: string,
  expectation: TerminalBufferExpectation,
  options: E2EWaitOptions = {},
): Promise<E2ETerminalSnapshot> {
  const serializedExpectation = {
    contains: expectation.contains,
    equals: expectation.equals,
    matches: expectation.matches
      ? { source: expectation.matches.source, flags: expectation.matches.flags }
      : undefined,
    occurrences: expectation.occurrences,
  };
  return page.evaluate(async ({ id, expectation, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    const pattern = expectation.matches === undefined
      ? undefined
      : new RegExp(expectation.matches.source, expectation.matches.flags);
    return api.waitForTerminal(id, (snapshot) => {
      const text = snapshot.xterm.text;
      const compactedText = text.replaceAll("\n", "");
      if (expectation.equals !== undefined && text !== expectation.equals) return false;
      const containsText = expectation.contains === undefined
        || expectation.contains.includes("\n")
        || text.includes(expectation.contains)
        ? text
        : compactedText;
      if (expectation.contains !== undefined && !containsText.includes(expectation.contains)) return false;
      if (pattern !== undefined) {
        pattern.lastIndex = 0;
        const rawMatch = pattern.test(text);
        pattern.lastIndex = 0;
        const compactedMatch = pattern.test(compactedText);
        if (!rawMatch && !compactedMatch) return false;
      }
      if (expectation.occurrences !== undefined && expectation.contains !== undefined) {
        let count = 0;
        let offset = 0;
        while ((offset = containsText.indexOf(expectation.contains, offset)) !== -1) {
          count += 1;
          offset += expectation.contains.length || 1;
        }
        if (count !== expectation.occurrences) return false;
      }
      return true;
    }, { timeout });
  }, {
    id: terminalId,
    expectation: serializedExpectation,
    timeout: options.timeout,
  });
}

export async function expectTerminalBuffer(
  page: Page,
  terminalId: string,
  expectation: TerminalBufferExpectation,
  options: E2EWaitOptions = {},
): Promise<void> {
  const snapshot = await waitForTerminalBuffer(page, terminalId, expectation, options);
  if (expectation.equals !== undefined) expect(snapshot.xterm.text).toBe(expectation.equals);
  if (expectation.contains !== undefined) {
    const containsText = comparableText(snapshot.xterm.text, expectation.contains);
    expect(containsText).toContain(expectation.contains);
    if (expectation.occurrences !== undefined) {
      let count = 0;
      let offset = 0;
      while ((offset = containsText.indexOf(expectation.contains, offset)) !== -1) {
        count += 1;
        offset += expectation.contains.length || 1;
      }
      expect(count).toBe(expectation.occurrences);
    }
  }
  if (expectation.matches !== undefined) {
    const pattern = expectation.matches;
    pattern.lastIndex = 0;
    const rawMatch = pattern.test(snapshot.xterm.text);
    pattern.lastIndex = 0;
    if (rawMatch) expect(snapshot.xterm.text).toMatch(pattern);
    else expect(snapshot.xterm.text.replaceAll("\n", "")).toMatch(pattern);
  }
}

export async function expectTerminalDimensions(
  page: Page,
  terminalId: string,
  dimensions: TerminalDimensions,
  options: E2EWaitOptions = {},
): Promise<E2ETerminalSnapshot> {
  const expected: Partial<E2ETerminalSnapshot> = {
    cols: dimensions.cols,
    rows: dimensions.rows,
    ...(dimensions.pixelWidth === undefined ? {} : { pixelWidth: dimensions.pixelWidth }),
    ...(dimensions.pixelHeight === undefined ? {} : { pixelHeight: dimensions.pixelHeight }),
  };
  const snapshot = await waitForTerminalState(page, terminalId, expected, options);
  expect(snapshot.cols).toBe(dimensions.cols);
  expect(snapshot.rows).toBe(dimensions.rows);
  if (dimensions.pixelWidth !== undefined) expect(snapshot.pixelWidth).toBe(dimensions.pixelWidth);
  if (dimensions.pixelHeight !== undefined) expect(snapshot.pixelHeight).toBe(dimensions.pixelHeight);
  return snapshot;
}

export async function expectTerminalConverged(
  page: Page,
  terminalId: string,
  dimensions: TerminalDimensions,
  options: E2EWaitOptions = {},
): Promise<E2ETerminalSnapshot> {
  const snapshot = await page.evaluate(async ({ id, dimensions, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (candidate) => {
      const viewport = candidate.serverViewport;
      if (!viewport) return false;
      const browserMatches = candidate.cols === dimensions.cols && candidate.rows === dimensions.rows;
      const serverMatches = viewport.cols === dimensions.cols && viewport.rows === dimensions.rows;
      const pixelsMatch = (dimensions.pixelWidth === undefined || candidate.pixelWidth === dimensions.pixelWidth)
        && (dimensions.pixelHeight === undefined || candidate.pixelHeight === dimensions.pixelHeight);
      return browserMatches && serverMatches && pixelsMatch;
    }, { timeout });
  }, {
    id: terminalId,
    dimensions: {
      cols: dimensions.cols,
      rows: dimensions.rows,
      pixelWidth: dimensions.pixelWidth,
      pixelHeight: dimensions.pixelHeight,
    },
    timeout: options.timeout,
  });
  expect(snapshot.serverViewport).toBeDefined();
  expect(snapshot.serverViewport?.cols).toBe(dimensions.cols);
  expect(snapshot.serverViewport?.rows).toBe(dimensions.rows);
  if (dimensions.pixelWidth !== undefined) expect(snapshot.pixelWidth).toBe(dimensions.pixelWidth);
  if (dimensions.pixelHeight !== undefined) expect(snapshot.pixelHeight).toBe(dimensions.pixelHeight);
  return snapshot;
}

export async function expectTerminalConnected(
  page: Page,
  terminalId: string,
  options: E2EWaitOptions = {},
): Promise<E2ETerminalSnapshot> {
  const snapshot = await waitForTerminalState(page, terminalId, { socketState: "connected" }, options);
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.activeSocketCount).toBe(1);
  return snapshot;
}

export async function expectTerminalSynchronized(
  page: Page,
  terminalId: string,
  options: E2EWaitOptions = {},
): Promise<E2ETerminalSnapshot> {
  const snapshot = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
  }, options);
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.acceptingInput).toBe(true);
  expect(snapshot.pendingParserWrites).toBe(0);
  return snapshot;
}

export async function expectTerminalInteractive(
  page: Page,
  terminalId: string,
  options: E2EWaitOptions = {},
): Promise<E2ETerminalSnapshot> {
  const snapshot = await waitForTerminalState(page, terminalId, { socketState: "connected", acceptingInput: true }, options);
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.acceptingInput).toBe(true);
  return snapshot;
}

export async function expectSingleTerminalSocket(
  page: Page,
  terminalId: string,
  options: E2EWaitOptions = {},
): Promise<void> {
  const snapshot = await waitForTerminalState(page, terminalId, { activeSocketCount: 1 }, options);
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.socket.activeCount).toBe(1);
}

export async function expectActiveBuffer(
  page: Page,
  terminalId: string,
  buffer: "normal" | "alternate",
  options: E2EWaitOptions = {},
): Promise<void> {
  const snapshot = await waitForTerminalState(page, terminalId, { activeBuffer: buffer }, options);
  expect(snapshot.xterm.activeBuffer).toBe(buffer);
}

export async function expectPaneInstance(
  page: Page,
  terminalId: string,
  paneId: string,
): Promise<void> {
  const pane = page.locator(`section[role="region"][data-terminal-id="${terminalId.replace(/["\\]/g, "\\$&")}"]`);
  await expect(pane).toHaveAttribute("data-pane-id", paneId);
  const snapshot = await terminalSnapshot(page, terminalId, paneId);
  expect(snapshot?.paneId).toBe(paneId);
}

export async function expectNoPendingRecovery(
  page: Page,
  terminalId: string,
  options: E2EWaitOptions = {},
): Promise<void> {
  const snapshot = await waitForTerminalState(page, terminalId, { socketState: "connected" }, options);
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.syncTarget === undefined || snapshot.committedSequence === undefined || snapshot.committedSequence >= snapshot.syncTarget).toBe(true);
  expect(snapshot.pendingParserWrites).toBe(0);
  expect(snapshot.renderBacklogBytes).toBe(0);
}

export async function assertMonotonicSequences(events: readonly E2ETerminalEvent[]): Promise<void> {
  let previousReceived: number | undefined;
  let previousCommitted: number | undefined;
  for (const event of events) {
    const { receivedSequence, committedSequence } = event.snapshot;
    if (previousReceived !== undefined && receivedSequence !== undefined) expect(receivedSequence).toBeGreaterThanOrEqual(previousReceived);
    if (previousCommitted !== undefined && committedSequence !== undefined) expect(committedSequence).toBeGreaterThanOrEqual(previousCommitted);
    previousReceived = receivedSequence ?? previousReceived;
    previousCommitted = committedSequence ?? previousCommitted;
  }
}

export async function expectBufferText(
  page: Page,
  terminalId: string,
  expectation: TerminalBufferExpectation,
  options: E2EWaitOptions = {},
): Promise<void> {
  await expectTerminalBuffer(page, terminalId, expectation, options);
}
