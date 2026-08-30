import { expect, test } from "../fixtures/test.js";
import { installBrowserErrorCollectors } from "../fixtures/artifacts.js";
import { LoginPage } from "../pages/login-page.js";
import { WorkbenchPage } from "../pages/workbench-page.js";

interface UpdateConfigResponse {
  enabled: boolean;
  channel: string;
  reason: string | null;
}

test("P0-23 Beta update channel persists through Settings @p0", async ({ page, baseURL }) => {
  const browserErrors = installBrowserErrorCollectors(page);
  await page.goto(baseURL);
  await new LoginPage(page).login();
  const workbench = new WorkbenchPage(page);
  await workbench.expectVisible();
  await workbench.openSettings();

  const beta = page.getByRole("checkbox", { name: "Receive beta releases", exact: true });
  await expect(beta).not.toBeChecked();
  const betaResponse = page.waitForResponse((response) => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname === "/api/config/updates"
  ));
  await beta.check();
  const selected = await (await betaResponse).json() as UpdateConfigResponse;
  expect(selected.channel).toBe("beta");
  await expect(beta).toBeChecked();

  await page.reload();
  await workbench.expectVisible();
  await workbench.openSettings();
  const persisted = page.getByRole("checkbox", { name: "Receive beta releases", exact: true });
  await expect(persisted).toBeChecked();
  await expect(page.getByText("Beta follows dev and may contain changes that have not reached main.", {
    exact: true,
  })).toBeVisible();

  const mainResponse = page.waitForResponse((response) => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname === "/api/config/updates"
  ));
  await persisted.click();
  const restored = await (await mainResponse).json() as UpdateConfigResponse;
  expect(restored.channel).toBe("main");
  await expect(persisted).not.toBeChecked();

  const unexpectedBrowserErrors = browserErrors().filter((entry) => (
    entry.kind === "pageerror"
    || entry.kind === "console" && /(?:error|uncaught|unhandled|react|preact)/i.test(entry.message)
  ));
  expect(unexpectedBrowserErrors).toEqual([]);
});
