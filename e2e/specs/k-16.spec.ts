import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import type { NetworkFaultDisposer, NetworkFaultEvent } from "../fixtures/network-faults.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
} from "../../src/client/lib/e2e-diagnostics.js";
import { TERMINAL_CHECKPOINT_FRAME_KIND } from "../../src/client/lib/terminal-checkpoint.js";
import {
  assertMonotonicSequences,
  expectNoPendingRecovery,
  expectSingleTerminalSocket,
  expectTerminalBuffer,
  expectTerminalSynchronized,
  terminalEvents,
  terminalSnapshot,
  waitForTerminalState,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import { expectTerminalNonBlank } from "../assertions/terminal-pixels.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 45_000;
const CHECKPOINT_DELAY_MS = 8_000;
const CHECKPOINT_FORWARD_SETTLE_MS = 500;
const TERMINAL_FRAME_HEADER_BYTES = 9;
const RENDER_BACKLOG_FAULT_BYTES = 16 * 1024 * 1024 + 1;
type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface CreatedTerminal {
  readonly id: string;
  readonly name: string;
}

interface CheckpointEventData {
  readonly chunks?: number;
}

async function createFixtureTerminal(
  page: Page,
  terminalPath: string,
  shell: string,
): Promise<CreatedTerminal> {
  return page.evaluate(async ({ path, shellPath }) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, cwd: "/tmp", shell: shellPath }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    const terminal = await response.json() as Partial<CreatedTerminal>;
    if (typeof terminal.id !== "string" || typeof terminal.name !== "string") {
      throw new Error("terminal creation response is missing identity");
    }
    return { id: terminal.id, name: terminal.name };
  }, { path: terminalPath, shellPath: shell });
}

async function waitForCheckpoint(
  page: Page,
  terminalId: string,
  afterEventId: number,
  sequence: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventFloor, expectedSequence, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > eventFloor
      && event.type === "checkpoint"
      && event.data.result === "sent"
      && event.data.sequence === expectedSequence
    ), { timeout, afterId: eventFloor });
  }, {
    id: terminalId,
    eventFloor: afterEventId,
    expectedSequence: sequence,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function waitForSnapshotSync(
  page: Page,
  terminalId: string,
  afterEventId: number,
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, eventFloor, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.type === "sync" && event.data.mode === "snapshot"
    ), { timeout, afterId: eventFloor });
  }, { id: terminalId, eventFloor: afterEventId, timeout: WAIT_TIMEOUT_MS });
}

function checkpointFrameCount(
  events: readonly NetworkFaultEvent[],
  terminalId: string,
  generation: number,
  sequence: number,
): number {
  return events.filter((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === generation
    && event.direction === "browser-to-server"
    && event.frame?.binaryKind === TERMINAL_CHECKPOINT_FRAME_KIND
    && event.frame.sequence === sequence
  )).length;
}

test("K-16 Checkpoint inside escape sequence cannot corrupt snapshot recovery @p0 @checkpoint @recovery", async ({
  page,
  baseURL,
  server,
  faultController,
}, testInfo: TestInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const runTag = `K16-${testInfo.project.name}-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-r${testInfo.retry}`
    .replace(/[^A-Za-z0-9_-]+/g, "-");
  const splitId = `${runTag}-split`;
  const liveMarker = `[E2E:CHECKPOINT_BOUNDARY:${splitId}:LIVE]`;
  const fixtureMarker = `[E2E:ESCAPE_DELAY:${splitId}]`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const created = await createFixtureTerminal(page, `k16-${runTag}`, server.fixturePath);
  await page.reload({ waitUntil: "load" });
  await workbench.expectVisible();
  const pane = await workbench.openTerminal({ id: created.id, name: created.name });
  await pane.expectVisible();
  const terminalId = created.id;

  const initial = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  if (initial.committedSequence === undefined) {
    throw new Error("initial diagnostics omitted the committed output sequence");
  }
  const connection = [...faultController.events].reverse().find((event) => (
    event.type === "connection-open"
    && event.terminalId === terminalId
    && event.generation !== undefined
  ));
  if (connection?.generation === undefined) {
    throw new Error(`missing reverse-proxy generation for terminal ${terminalId}`);
  }
  const initialGeneration = connection.generation;
  expect(initial.socketGeneration).toBe(initialGeneration);

  const eventsBeforeSplit = await terminalEvents(page, terminalId);
  const eventFloor = eventsBeforeSplit.at(-1)?.id ?? 0;
  const unsafeSequence = initial.committedSequence + 1;
  const encodedSequence = String.raw`\e[?1049h\e[2J\e[H${liveMarker}`;
  await pane.sendInput(
    `ESCAPE_DELAY ${splitId} ${encodedSequence} 1 ${CHECKPOINT_DELAY_MS}`,
    true,
  );
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "escape_delay"
      && entry.id === splitId
      && entry.phase === "prefix"
      && entry.split === 1,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  // The browser timer is intentionally throttled by the runtime under load.
  // Force the same production checkpoint callback after the parser boundary so
  // this protocol test does not depend on wall-clock scheduling.
  await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    api.controls.checkpoint.flush(id);
  }, terminalId);

  const checkpoint = await waitForCheckpoint(page, terminalId, eventFloor, unsafeSequence);
  const checkpointData = checkpoint.data as CheckpointEventData;
  if (typeof checkpointData.chunks !== "number" || checkpointData.chunks < 1) {
    throw new Error("unsafe-boundary checkpoint omitted its binary chunk count");
  }
  await faultController.waitFor((event) => (
    event.type === "frame"
    && event.terminalId === terminalId
    && event.generation === initialGeneration
    && event.direction === "browser-to-server"
    && event.frame?.binaryKind === TERMINAL_CHECKPOINT_FRAME_KIND
    && event.frame.sequence === unsafeSequence
    && checkpointFrameCount(
      faultController.events,
      terminalId,
      initialGeneration,
      unsafeSequence,
    ) >= checkpointData.chunks!
  ), { timeoutMs: WAIT_TIMEOUT_MS });
  // Network frame events fire before the proxy's socket write callback. The
  // protocol has no checkpoint acknowledgement, so leave a bounded loopback
  // drain window before pausing later browser-to-server traffic.
  await page.waitForTimeout(CHECKPOINT_FORWARD_SETTLE_MS);

  // Hold checkpoints produced after the delayed suffix. The unsafe upload is
  // already ordered through the proxy. Terminating the old connection drops
  // this queued traffic, so reconnect must use exactly the server state under
  // test instead of racing the next 750 ms idle checkpoint.
  const holdLaterCheckpoints = faultController.pause("browser-to-server", {
    terminalId,
    generation: initialGeneration,
  });
  let recoveredSync: E2ETerminalEvent | undefined;
  let terminateConnection: NetworkFaultDisposer | undefined;
  try {
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "escape_delay"
        && entry.id === splitId
        && entry.phase === "complete",
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    await expectTerminalBuffer(
      page,
      terminalId,
      { contains: liveMarker, occurrences: 1 },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const beforeReconnect = await waitForTerminalState(page, terminalId, {
      activeBuffer: "alternate",
      pendingParserWrites: 0,
      renderBacklogBytes: 0,
      renderBacklogFrames: 0,
    }, { timeout: WAIT_TIMEOUT_MS });
    expect(beforeReconnect.committedSequence).toBeGreaterThan(unsafeSequence);
    expect(beforeReconnect.xterm.text).toContain(fixtureMarker);

    // Force the real renderer-backlog recovery path after the safe checkpoint
    // boundary has advanced. The oversized frame is rejected before stream
    // acceptance; terminating that dropped socket makes the pane reconnect in
    // snapshot mode without changing its grid.
    const recoveryEventFloor = (await terminalEvents(page, terminalId)).at(-1)?.id ?? 0;
    const recoveredSyncPromise = waitForSnapshotSync(page, terminalId, recoveryEventFloor);
    await page.evaluate(({ id, generation, sequence, payloadBytes, headerBytes }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      const frame = new Uint8Array(headerBytes + payloadBytes);
      frame[0] = 1;
      new DataView(frame.buffer).setBigUint64(1, BigInt(sequence));
      api.controls.socket.deliverStaleEvent(id, {
        generation,
        type: "message",
        data: frame.buffer,
      });
    }, {
      id: terminalId,
      generation: initial.socketGeneration,
      sequence: beforeReconnect.committedSequence,
      payloadBytes: RENDER_BACKLOG_FAULT_BYTES,
      headerBytes: TERMINAL_FRAME_HEADER_BYTES,
    });
    terminateConnection = faultController.terminate({
      terminalId,
      generation: initialGeneration,
    });
    await faultController.waitFor((event) => (
      event.type === "terminated"
      && event.terminalId === terminalId
      && event.generation === initialGeneration
    ), { timeoutMs: WAIT_TIMEOUT_MS });
    recoveredSync = await recoveredSyncPromise;
  } finally {
    holdLaterCheckpoints.dispose();
    terminateConnection?.dispose();
  }
  if (!recoveredSync) throw new Error("terminal did not snapshot-resynchronize after forced reconnect");
  expect(recoveredSync.snapshot.socketGeneration).toBeGreaterThan(initial.socketGeneration);
  const recovered = await waitForTerminalState(page, terminalId, {
    socketState: "connected",
    activeSocketCount: 1,
    acceptingInput: true,
    pendingParserWrites: 0,
    pendingParserBytes: 0,
    renderBacklogBytes: 0,
    renderBacklogFrames: 0,
  }, { timeout: WAIT_TIMEOUT_MS });
  expect(recovered.xterm.activeBuffer).toBe("alternate");
  expect(recovered.xterm.text).toContain(liveMarker);
  expect(recovered.xterm.text).toContain(fixtureMarker);
  expect(recovered.xterm.text).not.toContain("[?1049h");

  const inputId = `${runTag}-after-recovery`;
  const inputMarker = `[E2E:PRINT:${inputId}:input-still-works]`;
  await pane.sendInput(`PRINT ${inputId} input-still-works`, true);
  await server.waitForTranscript(
    terminalId,
    (entry) => entry.event === "print" && entry.id === inputId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  await expectTerminalBuffer(
    page,
    terminalId,
    { contains: inputMarker, occurrences: 1 },
    { timeout: WAIT_TIMEOUT_MS },
  );

  const finalSnapshot = await terminalSnapshot(page, terminalId);
  if (!finalSnapshot) throw new Error(`missing final diagnostics for terminal ${terminalId}`);
  expect(finalSnapshot.activeBuffer).toBe("alternate");
  expect(finalSnapshot.acceptingInput).toBe(true);
  assertNoPendingSynchronization(finalSnapshot);
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectTerminalNonBlank(page, pane.xtermHost, {
    testInfo,
    artifactName: "k-16-parser-boundary-recovery",
  });

  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
  expect(server.stderr).not.toMatch(/\bpanic\b|\binternal server error\b/i);
  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /^error:/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
  browserErrors.dispose();
});
