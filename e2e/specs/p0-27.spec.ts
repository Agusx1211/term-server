import { Buffer } from "node:buffer";
import { rm, stat } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test, type IsolatedServer, type TranscriptEntry } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";

const WAIT_TIMEOUT_MS = 60_000;
const TEMP_UPLOAD_DIRECTORY = "/tmp/temp-server/files";
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

interface UploadedFile {
  path: string;
  size: number;
}

/** Headless browsers have no microphone, so `getUserMedia` is replaced with a
 * live oscillator stream. The real `MediaRecorder` still encodes it, so the
 * recorded container is whatever this browser would produce for a user. */
async function installFakeMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fakeGetUserMedia = async (): Promise<MediaStream> => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      void context.resume();
      return destination.stream;
    };
    // Patch the prototype: WebKit can hand out a fresh `mediaDevices` wrapper,
    // dropping anything defined on an earlier instance.
    if (typeof MediaDevices !== "undefined") {
      Object.defineProperty(MediaDevices.prototype, "getUserMedia", { configurable: true, value: fakeGetUserMedia });
    } else {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: fakeGetUserMedia } });
    }
  });
}

async function recordVoiceNote(
  page: Page,
  server: IsolatedServer,
  options: { viewport?: { width: number; height: number } } = {},
): Promise<void> {
  const browserErrors = installBrowserErrorCollectors(page);
  await installFakeMicrophone(page);
  if (options.viewport) await page.setViewportSize(options.viewport);
  await page.goto(server.baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await expect(workbench.root).toBeVisible();

  const mounted = page.evaluate(async ({ timeout }) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent("mount", { timeout });
  }, { timeout: WAIT_TIMEOUT_MS });
  await workbench.createTerminal();
  const terminalId = (await mounted).terminalId;
  const pane = workbench.terminal(terminalId);
  await pane.expectVisible();
  await pane.waitForSynchronized({ timeout: WAIT_TIMEOUT_MS });

  const record = pane.root.getByRole("button", { name: "Record a voice note for this terminal", exact: true });
  await expect(record).toBeVisible();
  if (options.viewport) {
    // Thumb-sized on phones, and reachable without opening the actions menu.
    const box = await record.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(40);
    expect(box?.height).toBeGreaterThanOrEqual(40);
  }

  // Discarding releases the microphone and uploads nothing.
  await record.click();
  await expect(pane.root.getByRole("button", { name: /^Stop and send voice note/ })).toBeVisible();
  await pane.root.getByRole("button", { name: "Discard voice note", exact: true }).click();
  await expect(record).toBeVisible();

  await record.click();
  const stop = pane.root.getByRole("button", { name: /^Stop and send voice note/ });
  await expect(stop).toBeVisible();
  await expect(stop).toHaveAccessibleName(/\(0:0[1-9]\)$/, { timeout: 10_000 });
  const upload = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/files/upload"
  ));
  await stop.click();
  const response = await upload;
  expect(response.ok()).toBe(true);
  expect(new URL(response.url()).searchParams.get("path")).toBe(TEMP_UPLOAD_DIRECTORY);
  const [uploaded] = await response.json() as UploadedFile[];
  if (!uploaded) throw new Error("the voice note upload returned no file");

  try {
    expect(uploaded.path).toMatch(
      /^\/tmp\/temp-server\/files\/voice-note-\d{4}(?:-\d{2}){5}(?: \(\d+\))?\.(?:webm|ogg|m4a|aac|wav)$/,
    );
    expect(uploaded.size).toBeGreaterThan(0);
    expect((await stat(uploaded.path)).size).toBe(uploaded.size);
    await expect(record).toBeVisible();

    // The path is typed into the terminal the note was recorded from.
    await pane.press("Enter");
    await server.waitForTranscript(terminalId, (entry: TranscriptEntry) => (
      entry.event === "command"
      && typeof entry.command_base64 === "string"
      && Buffer.from(entry.command_base64, "base64").toString("utf8").includes(uploaded.path)
    ), { timeoutMs: WAIT_TIMEOUT_MS });
  } finally {
    await rm(uploaded.path, { force: true });
  }

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console"
      && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
      // WebKit does not know the viewport meta's keyboard-resize hint.
      && !entry.message.includes("Viewport argument key \"interactive-widget\"")
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
}

test.describe("P0-27 voice notes", () => {
  test("P0-27 records a voice note into the temp folder and pastes its path @p0", async ({ page, server }) => {
    await recordVoiceNote(page, server);
  });

  test("P0-27 records a voice note from a phone-sized touch layout @p0", async ({ browser, browserName, server }) => {
    test.skip(browserName === "firefox", "Firefox has no mobile emulation");
    const context = await browser.newContext({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
    try {
      await recordVoiceNote(await context.newPage(), server, { viewport: MOBILE_VIEWPORT });
    } finally {
      await context.close();
    }
  });
});
