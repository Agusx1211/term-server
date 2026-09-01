import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { SidebarPage } from "../pages/sidebar-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

interface CreatedTerminal {
  id: string;
  name: string;
  cwd: string;
}

async function createTerminalInCwd(page: Page, cwd: string): Promise<CreatedTerminal> {
  return page.evaluate(async (workingDirectory) => {
    const response = await fetch("/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: workingDirectory }),
    });
    if (!response.ok) throw new Error(`terminal creation failed (${response.status})`);
    const terminal = await response.json() as Partial<CreatedTerminal>;
    if (typeof terminal.id !== "string" || typeof terminal.name !== "string" || typeof terminal.cwd !== "string") {
      throw new Error("terminal creation response is missing identity");
    }
    return { id: terminal.id, name: terminal.name, cwd: terminal.cwd };
  }, cwd);
}

/** Wait for `count` completed workspace polls, so a reload race would have run. */
async function waitForWorkspacePolls(page: Page, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/terminals" && response.ok()
    ), { timeout: 15_000 });
  }
}

test("P0-26 Saving a text document keeps the editor mounted @p0", async ({ page, server, baseURL }, testInfo) => {
  const browserErrors = installBrowserErrorCollectors(page);
  const workspaceDirectory = join(server.dataDir, "p026-workspace");
  await mkdir(workspaceDirectory, { recursive: true });
  const fileName = `p026-${testInfo.workerIndex}-${testInfo.retry}.txt`;
  const filePath = join(workspaceDirectory, fileName);
  const original = "first line\n";
  await writeFile(filePath, original, "utf8");

  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const created = await createTerminalInCwd(page, workspaceDirectory);
  await page.reload();
  await workbench.expectVisible();

  const sidebar = new SidebarPage(page);
  const pane = await sidebar.openTerminal(created.name);
  await pane.expectVisible();
  await sidebar.openFileExplorer();
  const explorer = page.locator(".file-explorer");
  await expect(explorer).toBeVisible();
  const result = explorer.locator("button.file-result").filter({ hasText: fileName });
  await expect(result).toBeVisible();
  await result.click();

  const documentPane = page.locator(".resource-document.active .text-document");
  const editor = documentPane.locator(".code-editor");
  const editorContent = editor.locator(".cm-content");
  await expect(editorContent).toContainText("first line");
  await expect(editor.locator(".cm-editor")).toHaveCount(1);

  const save = documentPane.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();

  const marker = `P026_EDIT_${testInfo.workerIndex}_${testInfo.retry}`;
  await editorContent.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(marker);
  await expect(editorContent).toContainText(marker);
  await expect(save).toBeEnabled();

  const saved = page.waitForResponse((response) => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === "/api/files/content"
  ));
  await page.keyboard.press("Control+s");
  expect((await saved).ok()).toBe(true);

  await expect(page.locator(".toast")).toHaveText(`Saved ${fileName}`);
  await expect(save).toBeDisabled();
  // The editor must survive its own save: the reload effect used to unmount the
  // CodeMirror host as soon as the tab stopped being dirty, leaving a blank pane.
  await expect(editor.locator(".cm-editor")).toHaveCount(1);
  await expect(editorContent).toContainText("first line");
  await expect(editorContent).toContainText(marker);
  const storedAfterSave = await readFile(filePath, "utf8");
  expect(storedAfterSave).toContain(original.trimEnd());
  expect(storedAfterSave).toContain(marker);

  // The workspace poll re-renders the tab; the buffer must stay put.
  await waitForWorkspacePolls(page, 2);
  await expect(editor.locator(".cm-editor")).toHaveCount(1);
  await expect(editorContent).toContainText(marker);

  const secondMarker = `${marker}_AGAIN`;
  await editorContent.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("_AGAIN");
  await expect(save).toBeEnabled();
  const savedAgain = page.waitForResponse((response) => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === "/api/files/content"
  ));
  await save.click();
  expect((await savedAgain).ok()).toBe(true);
  await expect(save).toBeDisabled();
  await expect(editorContent).toContainText(secondMarker);
  expect(await readFile(filePath, "utf8")).toContain(secondMarker);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
