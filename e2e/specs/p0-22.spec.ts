import { expect, test } from "../fixtures/test.js";
import { expectTerminalBuffer } from "../assertions/terminal-state.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import type { Page } from "@playwright/test";
import { TerminalPanePage } from "../pages/terminal-pane.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

const WAIT_TIMEOUT_MS = 20_000;

interface TerminalResponse {
  id: string;
  kind: "regular" | "supervisor";
  name: string;
  status: "running" | "exited";
  supervisorRoot?: string;
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

test("P0-22 Supervisor terminal is singleton, ordinary, and replaceable @p0", async ({
  page,
  baseURL,
}) => {
  const browserErrors = installBrowserErrorCollectors(page);
  let supervisorRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/supervisor") {
      supervisorRequests += 1;
    }
  });

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();

  const createSupervisor = page.getByRole("button", {
    name: "Create supervisor terminal",
    exact: true,
  });
  await expect(createSupervisor).toBeVisible();
  const supervisorActionBox = await createSupervisor.boundingBox();
  expect(supervisorActionBox?.width).toBeLessThanOrEqual(26);
  await expect(createSupervisor.locator("svg.lucide-crown")).toBeVisible();
  await expect(page.getByRole("button", { name: "New terminal in home", exact: true })).toBeVisible();
  const createdResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/supervisor"
  ));
  await createSupervisor.click();
  const created = await (await createdResponse).json() as TerminalResponse;
  expect(created.kind).toBe("supervisor");
  expect(created.status).toBe("running");

  const supervisorRow = page.locator(
    `.sidebar .terminal-row[data-terminal-id="${created.id}"]`,
  );
  await expect(supervisorRow).toHaveCount(1);
  await expect(supervisorRow).toHaveAttribute("data-terminal-kind", "supervisor");
  await expect(supervisorRow.locator('[data-supervisor-identity="sidebar"]')).toBeVisible();
  await expect(supervisorRow.locator("svg.lucide-crown")).toBeVisible();
  const pinnedSupervisor = page.locator('[data-supervisor-pinned-container="true"]');
  await expect(pinnedSupervisor).toHaveCount(1);
  await expect(supervisorRow).toHaveAttribute("data-supervisor-pinned", "true");
  await expect(page.locator(".workspace-tree [data-terminal-kind=\"supervisor\"]")).toHaveCount(0);
  await expect(supervisorRow.locator(".tree-main")).toHaveAttribute("title", "Supervisor terminal");
  await expect(page.locator(".sidebar")).not.toContainText(".local/share/term-server");
  const supervisorPane = new TerminalPanePage(page, created.id);
  await supervisorPane.expectVisible();
  await expect(supervisorPane.root).toHaveAttribute("data-terminal-kind", "supervisor");
  await expect(supervisorPane.root.locator('[data-supervisor-identity="pane"]')).toBeVisible();
  await expect(supervisorPane.root.locator(".supervisor-identity svg.lucide-crown")).toBeVisible();
  expect(supervisorRequests).toBe(1);
  const supervisorRoot = created.supervisorRoot;
  if (!supervisorRoot) throw new Error("supervisor root metadata is missing");
  await supervisorPane.expectConnected();
  await supervisorPane.sendInput("cd /tmp", true);
  await expect(supervisorPane.root).toHaveAttribute("data-supervisor-context", "outside", {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expect(supervisorPane.root.getByRole("status")).toContainText(
    "Supervisor skill discovery is inactive here",
  );
  await expect(supervisorRow).toHaveAttribute("data-supervisor-context", "outside");

  await supervisorPane.sendInput(`cd -- ${JSON.stringify(supervisorRoot)}`, true);
  await expect(supervisorPane.root).toHaveAttribute("data-supervisor-context", "active", {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expect(supervisorPane.root.getByRole("status")).toHaveCount(0);

  const openSupervisor = page.getByRole("button", {
    name: "Open supervisor terminal",
    exact: true,
  });
  await openSupervisor.click();
  await supervisorPane.expectVisible();
  expect(supervisorRequests).toBe(1);
  await expect(page.locator('.terminal-row[data-terminal-kind="supervisor"]')).toHaveCount(1);
  await expect(page.getByText(/Start (OMP|Pi|Codex|Claude)/)).toHaveCount(0);

  await workbench.createTerminal();
  const regularPane = page.locator('.terminal-pane[data-terminal-kind="regular"]:visible').first();
  await expect(regularPane).toBeVisible();
  await expect(regularPane).toHaveAttribute("data-supervisor", "false");
  await expect(regularPane.locator('[data-supervisor-identity="pane"]')).toHaveCount(0);
  const pinnedBox = await pinnedSupervisor.boundingBox();
  const firstWorkspaceRowBox = await page.locator(".workspace-tree .tree-row").first().boundingBox();
  expect(pinnedBox).not.toBeNull();
  expect(firstWorkspaceRowBox).not.toBeNull();
  expect(pinnedBox!.y).toBeLessThan(firstWorkspaceRowBox!.y);

  const regularId = await regularPane.getAttribute("data-terminal-id");
  if (!regularId) throw new Error("regular pane has no terminal id");
  await workbench.sidebar.splitTerminal({ id: created.id, name: created.name });
  await supervisorPane.expectVisible();
  await expect(page.locator('.terminal-pane[data-terminal-kind="regular"]:visible')).toHaveCount(1);
  const tabId = await terminalTabId(page, regularId);
  await page.waitForTimeout(1_200);
  await supervisorPane.sendInput(`term-server-supervisor close-tab ${tabId}`, true);
  await expect(page.locator(`.pane-slot:not(.cached)[data-terminal-id="${regularId}"]`)).toHaveCount(0, {
    timeout: WAIT_TIMEOUT_MS,
  });
  await expect(page.locator(`.sidebar .terminal-row[data-terminal-id="${regularId}"]`)).toHaveCount(1);
  await expectTerminalBuffer(page, created.id, {
    contains: "\"closed\": true",
    occurrences: 1,
  }, { timeout: WAIT_TIMEOUT_MS });
  await page.reload();
  await workbench.expectVisible();
  await expect(page.locator('.terminal-row[data-terminal-kind="supervisor"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Open supervisor terminal", exact: true }).click();
  await new TerminalPanePage(page, created.id).expectVisible();
  expect(supervisorRequests).toBe(1);

  const reloadedRow = page.locator(
    `.sidebar .terminal-row[data-terminal-id="${created.id}"]`,
  );
  await reloadedRow.hover();
  page.once("dialog", async (dialog) => dialog.accept());
  await reloadedRow.getByRole("button", { name: `Kill ${created.name}`, exact: true }).click();
  await expect(reloadedRow).toHaveCount(0);

  const replacementResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/supervisor"
  ));
  await page.getByRole("button", { name: "Create supervisor terminal", exact: true }).click();
  const replacement = await (await replacementResponse).json() as TerminalResponse;
  expect(replacement.id).not.toBe(created.id);
  expect(replacement.kind).toBe("supervisor");
  expect(supervisorRequests).toBe(2);
  await expect(page.locator('.terminal-row[data-terminal-kind="supervisor"]')).toHaveCount(1);
  await new TerminalPanePage(page, replacement.id).expectVisible();

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
