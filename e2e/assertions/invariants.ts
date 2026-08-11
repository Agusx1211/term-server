import { expect, type Page } from "@playwright/test";
import type {
  E2ETerminalEvent,
  E2ETerminalSnapshot,
  E2EWaitOptions,
} from "../../src/client/lib/e2e-diagnostics.js";
import {
  terminalEvents,
  waitForTerminalState,
} from "./terminal-state.js";

export interface TerminalInvariantReport {
  readonly snapshot: E2ETerminalSnapshot;
  readonly events: readonly E2ETerminalEvent[];
  readonly violations: readonly string[];
}

const numberIsNonNegative = (value: number | undefined): boolean => value === undefined || Number.isFinite(value) && value >= 0;

const sequenceViolations = (events: readonly E2ETerminalEvent[]): string[] => {
  const violations: string[] = [];
  let previousEventId = -1;
  let previousTimestamp = -1;
  let previousReceived: number | undefined;
  let previousCommitted: number | undefined;
  for (const event of events) {
    if (event.id <= previousEventId) violations.push("diagnostic event IDs are not strictly increasing");
    if (event.timestamp < previousTimestamp) violations.push("diagnostic event timestamps moved backwards");
    previousEventId = event.id;
    previousTimestamp = event.timestamp;
    const received = event.snapshot.receivedSequence;
    const committed = event.snapshot.committedSequence;
    if (received !== undefined && previousReceived !== undefined && received < previousReceived) {
      violations.push("received output sequence moved backwards");
    }
    if (committed !== undefined && previousCommitted !== undefined && committed < previousCommitted) {
      violations.push("parser-committed output sequence moved backwards");
    }
    if (received !== undefined && committed !== undefined && committed > received) {
      violations.push("parser-committed output sequence is ahead of received output");
    }
    previousReceived = received ?? previousReceived;
    previousCommitted = committed ?? previousCommitted;
  }
  return violations;
};

export function terminalInvariantViolations(
  snapshot: E2ETerminalSnapshot,
  events: readonly E2ETerminalEvent[] = [],
): string[] {
  const violations: string[] = [];
  if (snapshot.terminalId.length === 0) violations.push("terminal ID is empty");
  if (snapshot.paneId.length === 0) violations.push("pane instance ID is empty");
  if (!Number.isFinite(snapshot.activeSocketCount) || snapshot.activeSocketCount < 0 || snapshot.activeSocketCount > 1) {
    violations.push("a pane has more than one active socket or an invalid socket count");
  }
  if (!numberIsNonNegative(snapshot.cols) || !numberIsNonNegative(snapshot.rows)) {
    violations.push("terminal cell dimensions are negative or non-finite");
  }
  if (!numberIsNonNegative(snapshot.pixelWidth) || !numberIsNonNegative(snapshot.pixelHeight)) {
    violations.push("terminal pixel dimensions are negative or non-finite");
  }
  if (!numberIsNonNegative(snapshot.receivedSequence) || !numberIsNonNegative(snapshot.committedSequence)) {
    violations.push("terminal output sequence is negative or non-finite");
  }
  if (snapshot.receivedSequence !== undefined && snapshot.committedSequence !== undefined && snapshot.committedSequence > snapshot.receivedSequence) {
    violations.push("parser-committed output sequence is ahead of received output");
  }
  if (snapshot.lifecycle.visible && !snapshot.lifecycle.mounted) violations.push("visible pane is not mounted");
  if (snapshot.lifecycle.cached && !snapshot.lifecycle.mounted) violations.push("cached pane is not mounted");
  if (snapshot.lifecycle.active && !snapshot.lifecycle.visible) violations.push("active pane is hidden");
  if (snapshot.lifecycle.acceptingInput && snapshot.socketState !== "connected") {
    violations.push("terminal accepts input while its socket is not connected");
  }
  if (snapshot.syncTarget !== undefined && snapshot.committedSequence !== undefined && snapshot.socketState === "connected" && snapshot.committedSequence < snapshot.syncTarget && snapshot.lifecycle.acceptingInput) {
    violations.push("terminal accepts input before synchronization target is committed");
  }
  for (const viewport of [snapshot.proposedViewport, snapshot.desiredViewport, snapshot.urlViewport, snapshot.sentViewport, snapshot.serverViewport]) {
    if (!viewport) continue;
    if (!numberIsNonNegative(viewport.cols) || !numberIsNonNegative(viewport.rows) || !numberIsNonNegative(viewport.pixelWidth) || !numberIsNonNegative(viewport.pixelHeight)) {
      violations.push("viewport dimensions are negative or non-finite");
      break;
    }
  }
  violations.push(...sequenceViolations(events));

  const currentGeneration = snapshot.socketGeneration;
  for (const event of events) {
    if (event.type !== "socket-stale") continue;
    const generation = typeof event.data.generation === "number" ? event.data.generation : undefined;
    if (generation !== undefined && generation >= currentGeneration) {
      violations.push("stale socket event belongs to the current or newer generation");
    }
  }
  return [...new Set(violations)];
}

export async function expectTerminalInvariants(
  page: Page,
  terminalId: string,
  options: E2EWaitOptions = {},
): Promise<TerminalInvariantReport> {
  const snapshot = await waitForTerminalState(page, terminalId, {}, options);
  const events = await terminalEvents(page, terminalId);
  const violations = terminalInvariantViolations(snapshot, events);
  expect(violations, `terminal invariant violations for ${terminalId}`).toEqual([]);
  return { snapshot, events, violations };
}

export async function expectConnectedTerminalInvariants(
  page: Page,
  terminalId: string,
  options: E2EWaitOptions = {},
): Promise<TerminalInvariantReport> {
  const snapshot = await waitForTerminalState(page, terminalId, { socketState: "connected" }, options);
  const events = await terminalEvents(page, terminalId);
  const violations = terminalInvariantViolations(snapshot, events);
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.lifecycle.acceptingInput).toBe(true);
  expect(violations, `connected terminal invariant violations for ${terminalId}`).toEqual([]);
  return { snapshot, events, violations };
}

export function assertNoUnexpectedSocketMultiplication(
  snapshots: readonly E2ETerminalSnapshot[],
): void {
  for (const snapshot of snapshots) expect(snapshot.activeSocketCount).toBeLessThanOrEqual(1);
}

export function assertViewportDimensions(
  snapshot: E2ETerminalSnapshot,
  expected: { readonly cols: number; readonly rows: number },
): void {
  expect(snapshot.cols).toBe(expected.cols);
  expect(snapshot.rows).toBe(expected.rows);
  if (snapshot.serverViewport) {
    expect(snapshot.serverViewport.cols).toBe(expected.cols);
    expect(snapshot.serverViewport.rows).toBe(expected.rows);
  }
}

export function assertNoPendingSynchronization(snapshot: E2ETerminalSnapshot): void {
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.pendingParserWrites).toBe(0);
  expect(snapshot.renderBacklogBytes).toBe(0);
  if (snapshot.syncTarget !== undefined && snapshot.committedSequence !== undefined) {
    expect(snapshot.committedSequence).toBeGreaterThanOrEqual(snapshot.syncTarget);
  }
}
