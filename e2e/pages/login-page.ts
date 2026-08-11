import { expect, type Page } from "@playwright/test";

/** Semantic interactions with the unauthenticated term-server screen. */
export class LoginPage {
  readonly page: Page;
  readonly password;
  readonly connectButton;
  readonly clearSiteDataButton;

  constructor(page: Page) {
    this.page = page;
    this.password = page.getByLabel("Password", { exact: true });
    this.connectButton = page.getByRole("button", { name: "Connect", exact: true });
    this.clearSiteDataButton = page.getByRole("button", {
      name: "Clear cache and site data",
      exact: true,
    });
  }

  async expectVisible(): Promise<void> {
    await expect(this.page.getByRole("heading", { name: "term-server", exact: true })).toBeVisible();
    await expect(this.password).toBeVisible();
    await expect(this.connectButton).toBeVisible();
  }

  async expectError(message?: string | RegExp): Promise<void> {
    const alert = this.page.getByRole("alert");
    await expect(alert).toBeVisible();
    if (message !== undefined) await expect(alert).toHaveText(message);
  }

  async submit(password: string): Promise<void> {
    await this.password.fill(password);
    await this.connectButton.click();
  }

  /** Sign in without exposing the password through logs or returned values. */
  async login(password = process.env.TERM_SERVER_PASSWORD ?? "e2e-development"): Promise<void> {
    await this.expectVisible();
    await this.submit(password);
    await expect(this.page.locator(".workbench")).toBeVisible();
  }

  /** Alias useful in tests that describe the user action rather than the page. */
  async connect(password = process.env.TERM_SERVER_PASSWORD ?? "e2e-development"): Promise<void> {
    await this.login(password);
  }

  async clearSiteData(confirm = true): Promise<void> {
    await this.expectVisible();
    this.page.once("dialog", async (dialog) => {
      if (dialog.type() === "confirm") {
        await dialog[confirm ? "accept" : "dismiss"]();
      } else {
        await dialog.dismiss();
      }
    });
    await this.clearSiteDataButton.click();
  }

  async expectSignedIn(): Promise<void> {
    await expect(this.page.locator(".workbench")).toBeVisible();
  }

  async expectSignedOut(): Promise<void> {
    await expect(this.password).toBeVisible();
  }
}

export default LoginPage;
