import { expect, test } from "../fixtures/test.js";
import { expectTerminalBuffer } from "../assertions/terminal-state.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import type { Locator, Page } from "@playwright/test";
import type { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 20_000;
const CONTROL = '"$TERM_SERVER_EXECUTABLE" access terminals --agent e2e';

interface TerminalResponse {
  id: string;
  name: string;
  status: "running" | "exited";
}

async function createShellTerminal(page: Page, path: string): Promise<TerminalResponse> {
  return page.evaluate(async (path) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, cwd: "/tmp", shell: "/bin/sh" }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    return await response.json() as TerminalResponse;
  }, path);
}

async function terminalTabId(page: Page, terminalId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const viewId = sessionStorage.getItem("term-server:browser-view-id");
    if (!viewId) throw new Error("browser view id is unavailable");
    const compact = viewId.replaceAll("-", "");
    const viewBytes = Uint8Array.from(
      compact.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
    );
    const suffix = new TextEncoder().encode(`\0terminal\0${id}`);
    const input = new Uint8Array(viewBytes.length + suffix.length);
    input.set(viewBytes);
    input.set(suffix, viewBytes.length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    let binary = "";
    for (const byte of digest.slice(0, 12)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }, terminalId);
}

async function openAccessPanel(pane: TerminalPanePage) {
  const toggle = pane.root.getByRole("button", { name: /Open terminal access panel/ });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const section = pane.root.locator("[data-terminal-control-section]");
  await expect(section).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  return section;
}

function shareChoices(section: Locator): Locator {
  return section.getByRole("radiogroup", { name: "Share this terminal with controlling terminals" });
}

async function closeAccessPanel(pane: TerminalPanePage) {
  await pane.root.getByRole("button", { name: "Close access panel", exact: true }).click();
  await expect(pane.root.locator("[data-terminal-control-section]")).toHaveCount(0);
}

test("P0-22 Terminal control is off by default and granted per terminal @p0", async ({
  page,
  baseURL,
}) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let supervisorRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/supervisor") supervisorRequests += 1;
  });

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await expect(page.locator("svg.lucide-crown")).toHaveCount(0);

  const host = await createShellTerminal(page, "control-host");
  const target = await createShellTerminal(page, "control-target");
  const plain = await createShellTerminal(page, "control-plain");
  await page.reload({ waitUntil: "load" });
  await workbench.expectVisible();
  await expect(page.locator("[data-terminal-control-badge]")).toHaveCount(0);

  // Nothing is reachable until the user allows this terminal to control others.
  const hostPane = await workbench.openTerminal({ id: host.id, name: host.name });
  await hostPane.expectConnected();
  await hostPane.sendInput(`${CONTROL} list; echo "LIST-EXIT=$?"`, true);
  await expectTerminalBuffer(page, host.id, { contains: "LIST-EXIT=126" }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  const hostControl = await openAccessPanel(hostPane);
  await expect(shareChoices(hostControl).getByRole("radio", { name: "Default (Off)", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  page.once("dialog", async (dialog) => dialog.accept());
  await hostControl.locator("[data-terminal-controller-toggle]").click();
  await expect(hostPane.root.locator('[data-terminal-control-badge="controller"]')).toBeVisible({
    timeout: WAIT_TIMEOUT_MS,
  });
  await expect(
    page.locator(`.sidebar .terminal-row[data-terminal-id="${host.id}"] [data-terminal-control-badge="controller"]`),
  ).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  await closeAccessPanel(hostPane);

  // A hidden terminal looks exactly like a missing one.
  await hostPane.sendInput(`${CONTROL} list; echo "SELF-EXIT=$?"`, true);
  await expectTerminalBuffer(page, host.id, { contains: "SELF-EXIT=0" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expectTerminalBuffer(page, host.id, { contains: '"self": true' });
  await hostPane.sendInput(`${CONTROL} screen ${target.id}; echo "HIDDEN-EXIT=$?"`, true);
  await expectTerminalBuffer(page, host.id, { contains: "HIDDEN-EXIT=126" }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  // Read sharing exposes the screen but refuses input.
  const targetPane = await workbench.openTerminal({ id: target.id, name: target.name });
  await targetPane.expectConnected();
  await targetPane.sendInput("printf 'TARGET-READY\\n'", true);
  const targetControl = await openAccessPanel(targetPane);
  await shareChoices(targetControl).getByRole("radio", { name: "Read", exact: true }).click();
  await expect(targetPane.root.locator('[data-terminal-control-badge="read"]')).toBeVisible({
    timeout: WAIT_TIMEOUT_MS,
  });
  await closeAccessPanel(targetPane);

  await workbench.openTerminal({ id: host.id, name: host.name });
  await hostPane.sendInput(`${CONTROL} screen ${target.id}; echo "READ-EXIT=$?"`, true);
  await expectTerminalBuffer(page, host.id, { contains: "READ-EXIT=0" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expectTerminalBuffer(page, host.id, { contains: "TARGET-READY" });
  await hostPane.sendInput(
    `${CONTROL} send ${target.id} --text 'echo SHOULD-NOT-ARRIVE' --enter; echo "SEND-EXIT=$?"`,
    true,
  );
  await expectTerminalBuffer(page, host.id, { contains: "SEND-EXIT=126" }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  // Read & write sharing delivers input and logs it in the target's panel.
  await workbench.openTerminal({ id: target.id, name: target.name });
  const writableControl = await openAccessPanel(targetPane);
  page.once("dialog", async (dialog) => dialog.accept());
  await shareChoices(writableControl).getByRole("radio", { name: "Read & write", exact: true }).click();
  await expect(targetPane.root.locator('[data-terminal-control-badge="write"]')).toBeVisible({
    timeout: WAIT_TIMEOUT_MS,
  });
  await closeAccessPanel(targetPane);

  await workbench.openTerminal({ id: host.id, name: host.name });
  await hostPane.sendInput(
    `${CONTROL} send ${target.id} --text "printf 'CONTROL-DELIVERED\\\\n'" --enter`,
    true,
  );
  await expectTerminalBuffer(page, host.id, { contains: '"sent": true' }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await workbench.openTerminal({ id: target.id, name: target.name });
  await expectTerminalBuffer(page, target.id, { contains: "CONTROL-DELIVERED" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  const loggedControl = await openAccessPanel(targetPane);
  await expect(loggedControl).toContainText("e2e in control-host", { timeout: WAIT_TIMEOUT_MS });
  await expect(loggedControl).toContainText("typed");
  await closeAccessPanel(targetPane);

  // Closing a writable terminal's pane goes through the browser and keeps the session.
  await workbench.openTerminal({ id: host.id, name: host.name });
  await workbench.sidebar.splitTerminal({ id: target.id, name: target.name });
  await targetPane.expectVisible();
  const tabId = await terminalTabId(page, target.id);
  await page.waitForTimeout(1_200);
  await hostPane.sendInput(`${CONTROL} close-tab ${tabId}`, true);
  await expect(page.locator(`.pane-slot:not(.cached)[data-terminal-id="${target.id}"]`)).toHaveCount(0, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expect(page.locator(`.sidebar .terminal-row[data-terminal-id="${target.id}"]`)).toHaveCount(1);
  await expectTerminalBuffer(page, host.id, { contains: "\"closed\": true", occurrences: 1 }, {
    timeout: WAIT_TIMEOUT_MS,
  });

  // A terminal the controller opens is writable by it but cannot control others.
  await hostPane.sendInput(`${CONTROL} create --cwd /tmp --name opened-by-host`, true);
  const openedRow = page.locator(".sidebar .terminal-row").filter({
    has: page.locator(".terminal-title").filter({ hasText: /^opened-by-host$/ }),
  });
  await expect(openedRow).toHaveCount(1, { timeout: WAIT_TIMEOUT_MS });
  await expect(openedRow.locator('[data-terminal-control-badge="write"]')).toBeVisible();
  await expect(openedRow.locator('[data-terminal-control-badge="controller"]')).toHaveCount(0);

  // The default shares every terminal that has no setting of its own.
  await hostPane.sendInput(`${CONTROL} screen ${plain.id}; echo "PLAIN-HIDDEN=$?"`, true);
  await expectTerminalBuffer(page, host.id, { contains: "PLAIN-HIDDEN=126" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  const defaultsControl = await openAccessPanel(hostPane);
  await defaultsControl.locator('[data-default-exposure="read"]').click();
  await expect(defaultsControl.locator('[data-default-exposure="read"]')).toHaveAttribute(
    "aria-checked",
    "true",
    { timeout: WAIT_TIMEOUT_MS },
  );
  await closeAccessPanel(hostPane);
  await expect(
    page.locator(`.sidebar .terminal-row[data-terminal-id="${plain.id}"] [data-terminal-control-badge="read"]`),
  ).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  await hostPane.sendInput(`${CONTROL} screen ${plain.id}; echo "PLAIN-SHARED=$?"`, true);
  await expectTerminalBuffer(page, host.id, { contains: "PLAIN-SHARED=0" }, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expect(
    page.locator(`.sidebar .terminal-row[data-terminal-id="${target.id}"] [data-terminal-control-badge="write"]`),
  ).toBeVisible();

  // Settings survive a reload.
  await page.reload({ waitUntil: "load" });
  await workbench.expectVisible();
  await expect(
    page.locator(`.sidebar .terminal-row[data-terminal-id="${host.id}"] [data-terminal-control-badge="controller"]`),
  ).toBeVisible({ timeout: WAIT_TIMEOUT_MS });
  expect(supervisorRequests).toBe(0);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
