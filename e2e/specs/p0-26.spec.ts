import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { expectTerminalInteractive } from "../assertions/terminal-state.js";
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

test("Rendered Markdown keeps feedback outside the source @pr", async ({ page, server, baseURL }) => {
  const workspace = join(server.dataDir, "review-workspace");
  await mkdir(workspace);
  const file = join(workspace, "draft.md");
  const source = "# Review me\n\nShip this **tomorrow**.\n\n<script>unsafe()</script>\n";
  await writeFile(file, source);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const terminal = await createTerminalInCwd(page, workspace);
  await page.reload();
  const sidebar = new SidebarPage(page);
  const pane = await sidebar.openTerminal(terminal.name);
  await expectTerminalInteractive(page, terminal.id);
  await pane.sendInput("ECHO_INPUT review-path", true);
  await server.waitForTranscript(terminal.id, (entry) => entry.event === "echo_input" && entry.phase === "armed");
  await sidebar.openFileExplorer();
  const openDraft = () => page.locator("button.file-result").filter({ hasText: "draft.md" }).click();
  await openDraft();
  const article = page.locator(".markdown-preview article");
  await expect(article.getByRole("heading")).toHaveText("Review me");
  await expect(article.locator("script")).toHaveCount(0);
  const selectPassage = () => article.locator("strong").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await selectPassage();
  const comment = page.getByRole("textbox", { name: "Comment", exact: true });
  await comment.fill("Specify the date.");
  await page.getByRole("button", { name: "Edit source" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(comment).toHaveValue("Specify the date.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".markdown-comment")).toContainText("Specify the date.");
  const review = await page.locator(".markdown-preview section code").innerText();
  expect(JSON.parse(await readFile(review, "utf8"))).toMatchObject({ document: file, comments: [{ quote: "tomorrow", body: "Specify the date." }] });
  expect(await readFile(file, "utf8")).toBe(source);
  await page.getByRole("button", { name: `Paste path in ${terminal.name}` }).click();
  await expectTerminalInteractive(page, terminal.id);
  await pane.press("Enter");
  const echo = await server.waitForTranscript(terminal.id, (entry) => entry.event === "echo_input" && entry.phase === "payload");
  expect(echo.payload_base64).toBe(Buffer.from(review).toString("base64"));
  await page.locator(".resource-tabbar .resource-tab").filter({ hasText: "draft.md" }).click();
  await selectPassage();
  await comment.fill("Use an explicit deadline.");
  const external = source.replace("Ship this", "Please ship this");
  await writeFile(file, external);
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(article).toContainText("Please ship this");
  await expect(comment).toHaveValue("Use an explicit deadline.");
  await expect(page.getByRole("button", { name: "Add comment" })).toBeDisabled();
  await page.getByRole("button", { name: "Show passage" }).click();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("tomorrow");
  await selectPassage();
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".markdown-comment")).toHaveCount(2);
  await writeFile(file, external + "\ntomorrow\n");
  await page.getByRole("button", { name: "Refresh review" }).click();
  await expect(article.locator("p").last()).toHaveText("tomorrow");
  await page.getByRole("button", { name: "Show passage" }).first().click();
  await expect(page.getByRole("alert")).toHaveText("This passage changed or appears more than once in the current revision.");
  await writeFile(file, external.replace("tomorrow", "Friday"));
  await page.reload();
  await sidebar.openTerminal(terminal.name);
  await sidebar.openFileExplorer();
  await openDraft();
  await expect(article.locator("strong")).toHaveText("Friday");
  await expect(page.locator(".markdown-comment").first()).toContainText("From an earlier revision");
  await page.getByRole("button", { name: "Edit source" }).click();
  const editor = page.locator(".code-editor .cm-content");
  await expect(editor).toContainText("**Friday**");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("First edit.");
  let releaseSave!: () => void;
  const holdSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route("**/api/files/content", async (route) => {
    if (route.request().method() === "PUT") await holdSave;
    await route.continue();
  });
  const saving = page.waitForRequest((req) => req.method() === "PUT");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saving;
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Later edit.");
  releaseSave();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(await readFile(file, "utf8")).not.toContain("Later edit.");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText("Save your edits before adding a comment.")).toBeVisible();
});

test("Markdown review keeps comments beside their passages @pr", async ({ page, server, baseURL }) => {
  const workspace = join(server.dataDir, "layout-workspace");
  await mkdir(workspace);
  const file = join(workspace, "proposal.md");
  await writeFile(file, [
    "| Field | Value |",
    "| --- | --- |",
    "| Description | A short summary of the proposed change and why it matters. |",
    "| Discussion | Weekly review call |",
    "",
    "# Proposal",
    "",
    "The rollout starts with a single region and expands after one week.",
    "",
  ].join("\n"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const terminal = await createTerminalInCwd(page, workspace);
  await page.reload();
  const sidebar = new SidebarPage(page);
  await sidebar.openTerminal(terminal.name);
  await sidebar.openFileExplorer();
  await page.locator("button.file-result").filter({ hasText: "proposal.md" }).click();
  const article = page.locator(".markdown-preview article");
  await expect(article.getByRole("heading")).toHaveText("Proposal");

  // Table labels keep whole words on a single line.
  const label = article.getByRole("cell", { name: "Description", exact: true });
  expect(await label.evaluate((cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    return range.getClientRects().length;
  })).toBe(1);

  // A mouse selection opens the composer beside the passage; typing goes straight into it.
  const passage = "a single region";
  const points = await article.locator("p").evaluate((paragraph, quote) => {
    const node = paragraph.firstChild!;
    const start = node.textContent!.indexOf(quote);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + quote.length);
    const rects = Array.from(range.getClientRects());
    const first = rects[0]!;
    const last = rects[rects.length - 1]!;
    return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2, top: first.top };
  }, passage);
  await page.mouse.move(points.x1, points.y1);
  await page.mouse.down();
  await page.mouse.move(points.x2, points.y2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(passage);
  const comment = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(comment).toBeVisible();
  await page.keyboard.type("Which region goes first?");
  await expect(comment).toHaveValue("Which region goes first?");
  await page.keyboard.press("Control+Enter");
  const card = page.locator(".markdown-comment");
  await expect(card).toContainText("Which region goes first?");
  await expect(comment).toHaveCount(0);
  const cardBox = await card.boundingBox();
  const articleBox = await article.boundingBox();
  expect(cardBox!.x).toBeGreaterThan(articleBox!.x + articleBox!.width);
  expect(Math.abs(cardBox!.y - points.top)).toBeLessThan(24);
  const review = await page.locator(".markdown-preview section code").innerText();
  expect(JSON.parse(await readFile(review, "utf8"))).toMatchObject({ comments: [{ quote: passage, body: "Which region goes first?" }] });

  // Read hides review tools without losing an unsent draft.
  await article.locator("p").evaluate((paragraph) => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await comment.fill("Add the expansion criteria.");
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(comment).toHaveCount(0);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(card).toHaveCount(1);
  await expect(comment).toHaveValue("Add the expansion criteria.");
  expect(await readFile(file, "utf8")).toContain("The rollout starts with a single region");
});
