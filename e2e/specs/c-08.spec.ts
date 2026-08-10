import { test, expect } from "../fixtures/test.js";
import type { Page } from "@playwright/test";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  expectKnownMarkerChanged,
  expectTerminalNonBlank,
  screenshotRegion,
} from "../assertions/terminal-pixels.js";
import {
  assertMonotonicSequences,
  expectSingleTerminalSocket,
  expectNoPendingRecovery,
  expectTerminalBuffer,
  expectTerminalConverged,
  expectTerminalSynchronized,
  terminalEvents,
} from "../assertions/terminal-state.js";
import {
  assertNoPendingSynchronization,
  expectConnectedTerminalInvariants,
} from "../assertions/invariants.js";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
} from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 30_000;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface BuildInfo {
  readonly version: string;
  readonly commit: string;
}

interface BrokerGenerationInfo extends BuildInfo {
  readonly sessions: number;
  readonly current: boolean;
}

interface BrokerInfo extends BuildInfo {
  readonly sessions: number;
  readonly restartRequired: boolean;
  readonly generations: readonly BrokerGenerationInfo[];
}

interface ClientConfig {
  readonly broker: BrokerInfo | null;
}

interface TerminalApiInfo {
  readonly id: string;
  readonly name: string;
  readonly pid: number | null;
  readonly status: string;
  readonly clients: number;
  readonly broker: BuildInfo | null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("E2E API response was not an object");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`E2E API response field ${key} was not a string`);
  return field;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") throw new Error(`E2E API response field ${key} was not a boolean`);
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`E2E API response field ${key} was not a finite number`);
  return field;
}

function nullableNumberField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  if (field === null) return null;
  return numberField(value, key);
}

function parseBuildInfo(value: unknown, label: string): BuildInfo | null {
  if (value === undefined || value === null) return null;
  const fields = record(value);
  const version = stringField(fields, "version");
  const commit = stringField(fields, "commit");
  if (!version || !commit) throw new Error(`${label} broker identity was empty`);
  return { version, commit };
}

function parseTerminal(value: unknown): TerminalApiInfo {
  const fields = record(value);
  return {
    id: stringField(fields, "id"),
    name: stringField(fields, "name"),
    pid: nullableNumberField(fields, "pid"),
    status: stringField(fields, "status"),
    clients: numberField(fields, "clients"),
    broker: parseBuildInfo(fields.broker, "terminal"),
  };
}

function parseBroker(value: unknown): BrokerInfo | null {
  if (value === undefined || value === null) return null;
  const fields = record(value);
  const generationsValue = fields.generations;
  if (!Array.isArray(generationsValue)) throw new Error("session broker generations were not an array");
  return {
    version: stringField(fields, "version"),
    commit: stringField(fields, "commit"),
    sessions: numberField(fields, "sessions"),
    restartRequired: booleanField(fields, "restartRequired"),
    generations: generationsValue.map((generation) => {
      const entry = record(generation);
      return {
        version: stringField(entry, "version"),
        commit: stringField(entry, "commit"),
        sessions: numberField(entry, "sessions"),
        current: booleanField(entry, "current"),
      };
    }),
  };
}

function parseConfig(value: unknown): ClientConfig {
  const fields = record(value);
  return { broker: parseBroker(fields.broker) };
}

function errorMessage(value: unknown): string {
  const fields = record(value);
  return stringField(fields, "error");
}

async function waitForDiagnosticEventAfter(
  page: Page,
  terminalId: string,
  afterEventId: number,
  type: E2ETerminalEvent["type"],
  options: { readonly exactGeneration?: number; readonly minimumGeneration?: number } = {},
): Promise<E2ETerminalEvent> {
  return page.evaluate(async ({ id, after, eventType, exactGeneration, minimumGeneration, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent(id, (event) => (
      event.id > after
      && event.type === eventType
      && (exactGeneration === undefined || event.snapshot.socketGeneration === exactGeneration)
      && (minimumGeneration === undefined || event.snapshot.socketGeneration >= minimumGeneration)
    ), { timeout });
  }, {
    id: terminalId,
    after: afterEventId,
    eventType: type,
    exactGeneration: options.exactGeneration,
    minimumGeneration: options.minimumGeneration,
    timeout: WAIT_TIMEOUT_MS,
  });
}

async function latestDiagnosticEventId(page: Page, terminalId: string): Promise<number> {
  const events = await terminalEvents(page, terminalId);
  return events.at(-1)?.id ?? -1;
}

async function readTerminal(page: Page, terminalId: string): Promise<TerminalApiInfo> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/terminals");
    return { status: response.status, body: await response.json() as unknown };
  });
  if (result.status !== 200) throw new Error(`terminal list failed with HTTP ${result.status}`);
  const terminal = (result.body as TerminalApiInfo[]).find((entry) => entry.id === terminalId);
  if (!terminal) throw new Error(`terminal ${terminalId} is absent from the authenticated terminal list`);
  return terminal;
}

async function readConfig(page: Page): Promise<ClientConfig> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/config");
    return { status: response.status, body: await response.json() as unknown };
  });
  if (result.status !== 200) throw new Error(`config request failed with HTTP ${result.status}`);
  return result.body as ClientConfig;
}

async function postJson(
  page: Page,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as unknown };
  }, { path, body });
}

function generationKey(build: BuildInfo): string {
  return `${build.version}:${build.commit}`;
}

test("@p1 @nightly C-08 Broker generation restart", async ({ page, server, faultController }, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mounted = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, WAIT_TIMEOUT_MS);
  await workbench.createTerminal();
  const mountEvent = await mounted;
  const terminalId = mountEvent.terminalId;
  const terminal = workbench.terminal(terminalId);
  await terminal.expectVisible();
  const terminalViewport = terminal.xtermHost.locator(".xterm-screen");
  await expect(terminalViewport).toBeVisible();

  const initialSnapshot = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const initialTerminal = await readTerminal(page, terminalId);
  if (initialTerminal.pid === null) throw new Error(`terminal ${terminalId} has no PTY process identity`);
  if (!initialTerminal.broker) throw new Error(`terminal ${terminalId} has no broker generation identity`);
  const initialConfig = await readConfig(page);
  if (!initialConfig.broker) throw new Error("the isolated E2E server did not report a session broker");
  expect(initialConfig.broker.restartRequired).toBe(false);
  expect(initialConfig.broker.generations.filter((generation) => generation.current)).toHaveLength(1);
  const initialBrokerKey = generationKey(initialTerminal.broker);
  const initialGeneration = initialSnapshot.socketGeneration;
  const initialProxyOpen = await faultController.waitFor(
    (event) => event.type === "connection-open" && event.terminalId === terminalId,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  if (initialProxyOpen.generation === undefined) throw new Error("initial proxy connection did not expose a generation");

  const token = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}`;
  const readyId = `C08_READY_${token}`;
  const beforeId = `C08_BEFORE_${token}`;
  const beforeText = `[E2E:PRINT:${beforeId}:before-restart]`;
  const gate = `C08_GATE_${token}`;
  const afterId = `C08_AFTER_${token}`;
  const afterText = `[E2E:PRINT:${afterId}:after-restart]`;
  const sizeId = `C08_SIZE_${token}`;
  const echoId = `C08_ECHO_${token}`;
  const inputText = `C08_INPUT_${token}`;

  await terminal.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "ready" && entry.id === readyId, { timeoutMs: WAIT_TIMEOUT_MS });
  await terminal.sendInput(`PRINT ${beforeId} before-restart`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === beforeId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: beforeText, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const beforePixels = await screenshotRegion(page, terminalViewport);
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "c08-before-restart-crop",
  });

  await terminal.sendInput(`HOLD ${gate}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "hold" && entry.token === gate, { timeoutMs: WAIT_TIMEOUT_MS });

  const unchangedSocketEventId = await latestDiagnosticEventId(page, terminalId);
  const rejectedRestart = await postJson(page, "/api/broker/restart", { closeTerminals: false });
  expect(rejectedRestart.status).toBe(409);
  expect((rejectedRestart.body as { error?: string }).error).toContain("already running the current build");
  const afterRejectedEvents = await terminalEvents(page, terminalId);
  expect(afterRejectedEvents.filter((event) => event.id > unchangedSocketEventId && ["socket-close", "socket-created"].includes(event.type))).toEqual([]);
  const afterRejectedSnapshot = await terminal.snapshot();
  if (!afterRejectedSnapshot) throw new Error(`diagnostics disappeared for terminal ${terminalId} after rejected broker restart`);
  expect(afterRejectedSnapshot.socketGeneration).toBe(initialGeneration);
  expect(afterRejectedSnapshot.socketState).toBe("connected");
  expect(afterRejectedSnapshot.activeSocketCount).toBe(1);

  const restartBaseline = await latestDiagnosticEventId(page, terminalId);
  const serverSocketClose = waitForDiagnosticEventAfter(page, terminalId, restartBaseline, "socket-close", {
    exactGeneration: initialGeneration,
  });
  const replacementSocketOpen = waitForDiagnosticEventAfter(page, terminalId, restartBaseline, "socket-open", {
    minimumGeneration: initialGeneration + 1,
  });
  const replacementSynced = waitForDiagnosticEventAfter(page, terminalId, restartBaseline, "synced", {
    minimumGeneration: initialGeneration + 1,
  });
  const proxyDisconnected = faultController.waitFor(
    (event) => (
      (event.type === "connection-closed" || event.type === "connection-terminated")
      && event.terminalId === terminalId
      && event.generation === initialProxyOpen.generation
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const proxyReconnected = faultController.waitFor(
    (event) => (
      event.type === "connection-open"
      && event.terminalId === terminalId
      && event.generation !== undefined
      && event.generation > initialProxyOpen.generation!
    ),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );

  const restartResponse = await postJson(page, "/api/e2e/server/restart");
  expect(restartResponse.status).toBe(200);
  expect(restartResponse.body).toEqual({ ok: true });
  const closeEvent = await serverSocketClose;
  expect(closeEvent.snapshot.socketGeneration).toBe(initialGeneration);
  const [openEvent, syncedEvent] = await Promise.all([replacementSocketOpen, replacementSynced]);
  expect(openEvent.snapshot.socketGeneration).toBeGreaterThan(initialGeneration);
  expect(syncedEvent.snapshot.socketGeneration).toBe(openEvent.snapshot.socketGeneration);
  await Promise.all([proxyDisconnected, proxyReconnected]);

  const recovered = await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  expect(recovered.socketGeneration).toBeGreaterThan(initialGeneration);
  expect(recovered.activeSocketCount).toBe(1);
  expect(recovered.acceptingInput).toBe(true);
  expect(recovered.gridEpoch).toBe(initialSnapshot.gridEpoch);
  await expectTerminalConverged(page, terminalId, {
    cols: initialSnapshot.cols,
    rows: initialSnapshot.rows,
    pixelWidth: initialSnapshot.pixelWidth,
    pixelHeight: initialSnapshot.pixelHeight,
  }, { timeout: WAIT_TIMEOUT_MS });
  await expectSingleTerminalSocket(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  await expectNoPendingRecovery(page, terminalId, { timeout: WAIT_TIMEOUT_MS });

  const afterRestartTerminal = await readTerminal(page, terminalId);
  expect(afterRestartTerminal.id).toBe(initialTerminal.id);
  expect(afterRestartTerminal.pid).toBe(initialTerminal.pid);
  expect(afterRestartTerminal.status).toBe("running");
  expect(afterRestartTerminal.broker).toEqual(initialTerminal.broker);
  const afterRestartConfig = await readConfig(page);
  if (!afterRestartConfig.broker) throw new Error("session broker disappeared after normal server restart");
  expect(generationKey(afterRestartConfig.broker)).toBe(generationKey(initialConfig.broker));
  const retainedGeneration = afterRestartConfig.broker.generations.find(
    (generation) => generationKey(generation) === initialBrokerKey,
  );
  expect(retainedGeneration?.sessions).toBeGreaterThan(0);
  expect(afterRestartConfig.broker.generations.filter((generation) => generation.current)).toHaveLength(1);

  await terminal.sendInput(`RELEASE ${gate}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "release" && entry.token === gate, { timeoutMs: WAIT_TIMEOUT_MS });
  await terminal.sendInput(`PRINT ${afterId} after-restart`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "print" && entry.id === afterId, { timeoutMs: WAIT_TIMEOUT_MS });
  await expectTerminalBuffer(page, terminalId, { contains: afterText, occurrences: 1 }, { timeout: WAIT_TIMEOUT_MS });
  const { after: afterPixels } = await expectKnownMarkerChanged(page, terminalViewport, beforePixels, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "c08-after-restart-crop",
  });
  expect(afterPixels.width).toBe(beforePixels.width);
  expect(afterPixels.height).toBe(beforePixels.height);
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "c08-final-crop",
  });

  await terminal.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(terminalId, (entry) => entry.event === "size" && entry.id === sizeId, { timeoutMs: WAIT_TIMEOUT_MS });
  expect(size.cols).toBe(initialSnapshot.cols);
  expect(size.rows).toBe(initialSnapshot.rows);
  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed", { timeoutMs: WAIT_TIMEOUT_MS });
  await terminal.sendInput(inputText, true);
  const echoed = await server.waitForTranscript(terminalId, (entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload", { timeoutMs: WAIT_TIMEOUT_MS });
  expect(echoed.payload_base64).toBe(Buffer.from(inputText, "utf8").toString("base64"));

  const transcript = await server.readTranscript(terminalId);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === beforeId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === afterId)).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload")).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toEqual([]);

  const finalEvents = await terminalEvents(page, terminalId);
  await assertMonotonicSequences(finalEvents);
  expect(finalEvents.filter((event) => event.type === "error")).toEqual([]);
  await expectConnectedTerminalInvariants(page, terminalId, { timeout: WAIT_TIMEOUT_MS });
  const finalSnapshot = await terminal.snapshot();
  if (!finalSnapshot) throw new Error(`diagnostics disappeared for terminal ${terminalId} at test completion`);
  expect(finalSnapshot.socketState).toBe("connected");
  expect(finalSnapshot.activeSocketCount).toBe(1);
  expect(finalSnapshot.socket.activeCount).toBe(1);
  assertNoPendingSynchronization(finalSnapshot);

  const newTerminalMount = page.evaluate(async ({ oldId, timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount" && event.terminalId !== oldId, { timeout });
  }, { oldId: terminalId, timeout: WAIT_TIMEOUT_MS });
  const createResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/terminals"
  ));
  await workbench.createTerminal();
  const [createResponse, newMount] = await Promise.all([createResponsePromise, newTerminalMount]);
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as TerminalApiInfo;
  expect(newMount.terminalId).toBe(created.id);
  const newTerminal = workbench.terminal(created.id, created.name);
  await newTerminal.expectVisible();
  const newSnapshot = await expectTerminalSynchronized(page, created.id, { timeout: WAIT_TIMEOUT_MS });
  expect(newSnapshot.activeSocketCount).toBe(1);
  const newTerminalInfo = await readTerminal(page, created.id);
  if (!newTerminalInfo.broker) throw new Error(`new terminal ${created.id} has no broker generation identity`);
  const currentGeneration = afterRestartConfig.broker.generations.find((generation) => generation.current);
  if (!currentGeneration) throw new Error("session broker has no current generation after restart");
  expect(generationKey(newTerminalInfo.broker)).toBe(generationKey(currentGeneration));
  expect(newTerminalInfo.status).toBe("running");

  expect(afterRestartTerminal.clients).toBeGreaterThanOrEqual(1);
  expect(newTerminalInfo.clients).toBeGreaterThanOrEqual(1);
});
