import { test, expect } from "../fixtures/test.js";
import LoginPage from "../pages/login-page.js";
import WorkbenchPage from "../pages/workbench-page.js";
import {
  analyzePixels,
  expectTerminalNonBlank,
  expectTerminalPixelsChanged,
  screenshotRegion,
  type TerminalPixelImage,
} from "../assertions/terminal-pixels.js";
import {
  expectTerminalBuffer,
  terminalEvents,
} from "../assertions/terminal-state.js";
import { expectTerminalInvariants } from "../assertions/invariants.js";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

test("@p0 @smoke P0-01 Cold start renders and accepts input", async ({ page, server }, testInfo) => {
  await page.goto("/");
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const mountEvent = page.evaluate(async () => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout: 15_000 });
  });
  await workbench.createTerminal();
  const mounted = await mountEvent;
  const terminalId = mounted.terminalId;
  const terminal = workbench.terminal(terminalId);
  await terminal.expectVisible();
  const terminalViewport = terminal.xtermHost.locator(".xterm-screen");
  await expect(terminalViewport).toBeVisible();

  const waitForVisibleCompositor = async (): Promise<TerminalPixelImage> => {
    let settledImage: TerminalPixelImage | undefined;
    await expect.poll(async () => {
      try {
        const image = await screenshotRegion(page, terminalViewport);
        const analysis = analyzePixels(image);
        const pixelCount = image.width * image.height;
        const visible = analysis.nonBackgroundRatio >= 0.002
          && analysis.dominantColorPixels <= Math.floor(pixelCount * (1 - 0.002));
        if (visible) settledImage = image;
        return visible;
      } catch {
        return false;
      }
    }, {
      message: "terminal compositor did not settle with visible pixels",
      timeout: 15_000,
      intervals: [50, 100, 250, 500],
    }).toBe(true);
    if (!settledImage) throw new Error("terminal compositor produced no settled screenshot");
    return settledImage;
  };
  const waitForRenderedOutput = async (minimumRenderCount: number): Promise<void> => {
    await page.evaluate(async ({ id, minimumRenderCount }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      await api.waitForTerminal(id, (snapshot) => (
        snapshot.renderCount > minimumRenderCount
        && snapshot.pendingParserWrites === 0
        && snapshot.pendingParserBytes === 0
        && snapshot.renderBacklogBytes === 0
        && snapshot.renderBacklogFrames === 0
      ), { timeout: 15_000 });
    }, { id: terminalId, minimumRenderCount });
  };

  await page.evaluate(async ({ id }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    await api.waitForEvent((event) => (
      event.terminalId === id
      && event.type === "font-load"
      && event.data.result === "settled"
    ), { timeout: 15_000 });
  }, { id: terminalId });

  const token = `${testInfo.workerIndex}-${testInfo.parallelIndex}-${Date.now()}`;
  const readyId = `COLD-READY-${token}`;
  const sizeId = `COLD-SIZE-${token}`;
  const outputMarker = `COLD-OUT-${token}`;
  const echoId = `COLD-ECHO-${token}`;
  const inputMarker = `COLD-IN-${token}`;

  const initial = await page.evaluate(async ({ id }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForTerminal(id, (snapshot) => (
      snapshot.socketState === "connected"
      && snapshot.acceptingInput
      && snapshot.pendingParserWrites === 0
      && snapshot.serverViewport !== undefined
      && snapshot.sentViewport !== undefined
      && snapshot.serverViewport.cols === snapshot.sentViewport.cols
      && snapshot.serverViewport.rows === snapshot.sentViewport.rows
      && snapshot.serverViewport.cols === snapshot.cols
      && snapshot.serverViewport.rows === snapshot.rows
    ), { timeout: 15_000 });
  }, { id: terminalId });
  expect(initial.socketState).toBe("connected");
  expect(initial.acceptingInput).toBe(true);
  expect(initial.pendingParserWrites).toBe(0);
  expect(initial.serverViewport).toBeDefined();
  expect(initial.serverViewport?.cols).toBe(initial.cols);
  expect(initial.serverViewport?.rows).toBe(initial.rows);

  await terminal.sendInput(`SIZE ${sizeId}`, true);
  const size = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "size" && entry.id === sizeId
  ));
  expect(size.rows).toBe(initial.rows);
  expect(size.cols).toBe(initial.cols);

  await terminal.sendInput(`READY ${readyId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "ready" && entry.id === readyId
  ));
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:READY:${readyId}]`,
    occurrences: 1,
  });
  await waitForRenderedOutput(initial.renderCount);
  const beforePrint = await waitForVisibleCompositor();
  const beforePrintSnapshot = await terminal.snapshot();
  if (!beforePrintSnapshot) throw new Error("missing diagnostics snapshot before marker input");

  await terminal.sendInput(`PRINT ${outputMarker} visible`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "print" && entry.id === outputMarker
  ));
  await expectTerminalBuffer(page, terminalId, {
    contains: `[E2E:PRINT:${outputMarker}:visible]`,
    occurrences: 1,
  });
  await waitForRenderedOutput(beforePrintSnapshot.renderCount);
  const afterPrint = await waitForVisibleCompositor();
  await expectTerminalPixelsChanged(beforePrint, afterPrint, {
    minimumChangedRatio: 0.002,
    testInfo,
    artifactName: "p0-01-output-marker-crop",
  });
  await expectTerminalNonBlank(page, terminalViewport, {
    testInfo,
    artifactName: "p0-01-output-crop",
  });
  expect(afterPrint.width).toBe(beforePrint.width);
  expect(afterPrint.height).toBe(beforePrint.height);

  await terminal.sendInput(`ECHO_INPUT ${echoId}`, true);
  await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "armed"
  ));
  await terminal.sendInput(inputMarker, true);
  const payload = await server.waitForTranscript(terminalId, (entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
  ));
  expect(payload.payload_base64).toBe(Buffer.from(inputMarker, "utf8").toString("base64"));

  const transcript = await server.readTranscript(terminalId);
  const expectedOutput = `[E2E:PRINT:${outputMarker}:visible]\n`;
  expect(transcript.filter((entry) => entry.event === "print" && entry.id === outputMarker)).toHaveLength(1);
  expect(transcript.some((entry) => entry.event === "write" && entry.text === expectedOutput)).toBe(true);
  const payloads = transcript.filter((entry) => (
    entry.event === "echo_input" && entry.id === echoId && entry.phase === "payload"
  ));
  expect(payloads).toHaveLength(1);
  expect(transcript.filter((entry) => entry.event === "error")).toHaveLength(0);
  const snapshot = await page.evaluate((id) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.terminal(id);
  }, terminalId);
  if (!snapshot) throw new Error(`No diagnostics snapshot for terminal ${terminalId}`);
  expect(snapshot.cols).toBe(initial.cols);
  expect(snapshot.rows).toBe(initial.rows);
  expect(snapshot.serverViewport?.cols).toBe(initial.cols);
  expect(snapshot.serverViewport?.rows).toBe(initial.rows);
  expect(snapshot.activeSocketCount).toBe(1);
  expect(snapshot.socket.activeCount).toBe(1);
  expect(snapshot.socketState).toBe("connected");
  expect(snapshot.acceptingInput).toBe(true);

  const events = await terminalEvents(page, terminalId);
  const socketCreated = events.filter((event) => event.type === "socket-created");
  const socketClosed = events.filter((event) => event.type === "socket-close");
  expect(socketCreated).toHaveLength(1);
  expect(socketClosed).toHaveLength(0);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => (
    event.type === "state"
    && ["disconnected", "recovering"].includes(String(event.data.state))
  ))).toHaveLength(0);

  let previousSyncMode: string | undefined;
  let snapshotSyncStarts = 0;
  for (const event of events) {
    if (event.type !== "snapshot") continue;
    const streamValue = event.data["stream"];
    if (!streamValue || typeof streamValue !== "object") continue;
    const modeValue = Reflect.get(streamValue, "syncMode");
    const mode = typeof modeValue === "string" ? modeValue : undefined;
    if (mode === "snapshot" && previousSyncMode !== "snapshot") snapshotSyncStarts += 1;
    previousSyncMode = mode;
  }
  expect(snapshotSyncStarts).toBe(1);
  const invariantReport = await expectTerminalInvariants(page, terminalId, { timeout: 15_000 });
  expect(invariantReport.violations).toEqual([]);
  const finalSnapshot = invariantReport.snapshot;
  expect(finalSnapshot.socketGeneration).toBe(1);
  expect(finalSnapshot.syncTarget === undefined || finalSnapshot.committedSequence === undefined || finalSnapshot.committedSequence >= finalSnapshot.syncTarget).toBe(true);
});
