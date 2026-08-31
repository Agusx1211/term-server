import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

test("P0-25 Settings are grouped into responsive sections @p0", async ({ page, baseURL }) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  const settings = await workbench.openSettings();

  const navigation = settings.root.getByRole("navigation", {
    name: "Settings sections",
    exact: true,
  });
  await expect(navigation.getByRole("button")).toHaveCount(4);
  await expect(navigation.getByRole("button", { name: "Workspace", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect(settings.root.getByRole("heading", { name: "Appearance", exact: true }))
    .toBeVisible();
  await expect(settings.root.getByRole("heading", {
    name: "Completion notifications",
    exact: true,
  })).toBeHidden();

  await settings.openSection("Notifications");
  await expect(settings.root.getByRole("heading", {
    name: "Completion notifications",
    exact: true,
  })).toBeVisible();
  await expect(settings.root.getByRole("heading", { name: "Pushover notifications", exact: true }))
    .toBeVisible();

  await settings.openSection("Agents");
  await expect(settings.root.getByRole("heading", { name: "Artifact skill", exact: true }))
    .toBeVisible();
  await expect(settings.root.getByRole("heading", { name: "Live agent activity", exact: true }))
    .toBeVisible();

  await settings.openSection("System");
  await expect(settings.root.getByRole("heading", { name: "Updates", exact: true }))
    .toBeVisible();
  await expect(settings.root.getByRole("heading", { name: "Security", exact: true }))
    .toBeVisible();
  await expect(settings.root.getByRole("heading", {
    name: "Completion notifications",
    exact: true,
  })).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await settings.openSection("Workspace");
  await expect(navigation).toBeVisible();
  const navigationRows = await navigation.getByRole("button").evaluateAll((buttons) => (
    new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().y))).size
  ));
  expect(navigationRows).toBe(2);
  const appearanceBox = await settings.root.getByRole("heading", { name: "Appearance", exact: true })
    .locator("..")
    .boundingBox();
  const behaviorBox = await settings.root.getByRole("heading", { name: "Terminal behavior", exact: true })
    .locator("..")
    .boundingBox();
  expect(appearanceBox).not.toBeNull();
  expect(behaviorBox).not.toBeNull();
  expect(Math.abs((appearanceBox?.x ?? 0) - (behaviorBox?.x ?? 0))).toBeLessThan(1);
  expect((behaviorBox?.y ?? 0)).toBeGreaterThan(appearanceBox?.y ?? 0);
  expect(await settings.root.locator(".settings-page").evaluate((element) => (
    element.scrollWidth <= element.clientWidth
  ))).toBe(true);

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
