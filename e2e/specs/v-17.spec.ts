import { expect, test } from "../fixtures/test.js";
import type { E2ETerminalDiagnosticsApi } from "../../src/client/lib/e2e-diagnostics.js";
import { expectTerminalSynchronized } from "../assertions/terminal-state.js";
import { LoginPage } from "../pages/login-page.js";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT = 30_000;
const MOBILE_VIEWPORT = { width: 390, height: 844, offsetTop: 0 } as const;
const KEYBOARD_VIEWPORT = { width: 390, height: 500, offsetTop: 344 } as const;
const MOBILE_DPR = 2;

test.use({
  viewport: { width: MOBILE_VIEWPORT.width, height: MOBILE_VIEWPORT.height },
  deviceScaleFactor: MOBILE_DPR,
  isMobile: true,
  hasTouch: true,
});

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

type CdpSessionLike = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};

type VisualViewportTarget = typeof MOBILE_VIEWPORT | typeof KEYBOARD_VIEWPORT;

// The virtual keyboard cannot be raised in headless Chromium; what the client
// sees when it does is the visual viewport shrinking, which CDP can emulate.
async function setVisualViewport(cdp: CdpSessionLike, target: VisualViewportTarget): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: target.width,
    height: target.height,
    deviceScaleFactor: MOBILE_DPR,
    mobile: true,
    screenWidth: MOBILE_VIEWPORT.width,
    screenHeight: MOBILE_VIEWPORT.height,
    viewport: {
      x: 0,
      y: target.offsetTop,
      width: target.width,
      height: target.height,
      scale: 1,
    },
  });
}

test("V-17 Mobile keyboard button shows and hides the virtual keyboard @pr @mobile @input", async ({ page, baseURL, server }, testInfo) => {
  test.skip(
    page.context().browser()?.browserType().name() !== "chromium",
    "visual viewport emulation needs CDP",
  );
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const captureId = `V17-w${testInfo.workerIndex}-p${testInfo.parallelIndex}-ESC`;

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  // The mobile layout keeps the sidebar closed and greets with the welcome screen.
  await expect(workbench.root).toBeVisible();

  const mountBarrier = page.evaluate(async (timeout) => {
    const api = (window as E2EWindow).__TERM_SERVER_E2E__;
    if (!api) throw new Error("term-server E2E diagnostics are unavailable");
    return api.waitForEvent((event) => event.type === "mount", { timeout });
  }, WAIT_TIMEOUT);
  await workbench.createTerminal();
  const mount = await mountBarrier;
  const terminalId = mount.terminalId;
  const pane = new TerminalPanePage(page, terminalId);
  await pane.expectVisible();
  await expectTerminalSynchronized(page, terminalId, { timeout: WAIT_TIMEOUT });

  const keybar = pane.root.getByRole("navigation", { name: "Terminal keyboard shortcuts", exact: true });
  await expect(keybar).toBeVisible();
  const toggle = keybar.getByRole("button", { name: /^(Show|Hide) keyboard$/ });
  const helperTextarea = pane.xtermHost.locator(".xterm-helper-textarea");
  await expect(helperTextarea).toBeAttached();

  // Pane activation focuses the textarea from code, which raises no keyboard
  // on iOS; with the viewport at full height the button still offers to show.
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("data-keyboard", "closed");
  await expect(toggle).toHaveAccessibleName("Show keyboard");

  await toggle.tap();
  await expect(helperTextarea).toBeFocused();

  const cdp = await page.context().newCDPSession(page);
  try {
    // The keyboard raising shrinks the visual viewport: the button flips to hide.
    await setVisualViewport(cdp, KEYBOARD_VIEWPORT);
    await expect(toggle).toHaveAttribute("data-keyboard", "open");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAccessibleName("Hide keyboard");

    // Typing reaches the terminal through the focus the button took.
    await page.keyboard.type(`CAPTURE_INPUT ${captureId} 1`);
    await page.keyboard.press("Enter");
    await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "capture_input" && entry.id === captureId && entry.phase === "armed",
      { timeoutMs: WAIT_TIMEOUT },
    );

    // Hiding blurs the textarea, and the viewport growing back leaves the
    // button offering to show again.
    await toggle.tap();
    await expect(helperTextarea).not.toBeFocused();
    await expect(toggle).toHaveAttribute("data-keyboard", "closed");
    await setVisualViewport(cdp, MOBILE_VIEWPORT);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveAccessibleName("Show keyboard");

    // Keybar keys keep working without bringing the keyboard back.
    await keybar.getByRole("button", { name: "Esc", exact: true }).tap();
    const captured = await server.waitForTranscript(
      terminalId,
      (entry) => entry.event === "capture_input" && entry.id === captureId && entry.phase === "complete",
      { timeoutMs: WAIT_TIMEOUT },
    );
    expect(captured.payload_base64).toBe(Buffer.from("\u001b", "utf8").toString("base64"));
    await expect(helperTextarea).not.toBeFocused();

    // A tap on the terminal itself asks for the keyboard again.
    await pane.xtermHost.tap();
    await expect(helperTextarea).toBeFocused();
  } finally {
    await cdp.detach();
  }

  expect(browserErrors).toEqual([]);
});
