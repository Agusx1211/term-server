import { expect, type Locator, type Page } from "@playwright/test";

/** Semantic controls for the settings workspace. */
export class SettingsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  get root(): Locator {
    return this.page.locator("section.settings-workspace");
  }

  get heading(): Locator {
    return this.root.getByRole("heading", { name: "Settings", exact: true });
  }

  async expectVisible(): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.root).toHaveAttribute("aria-hidden", "false");
  }

  async expectHidden(): Promise<void> {
    await expect(this.root).toBeHidden();
  }

  async chooseTheme(theme: "dark" | "light"): Promise<void> {
    await this.root.getByRole("group", { name: "Color theme", exact: true })
      .getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true })
      .click();
  }

  async setToggle(label: string, checked: boolean): Promise<void> {
    const toggle = this.root.getByRole("checkbox", { name: label, exact: true });
    if (checked) await toggle.check();
    else await toggle.uncheck();
  }

  async toggle(label: string): Promise<void> {
    const toggle = this.root.getByRole("checkbox", { name: label, exact: true });
    await toggle.click();
  }

  async choosePreviewMode(mode: "compact" | "large"): Promise<void> {
    const group = this.root.getByRole("radiogroup").filter({
      has: this.root.locator('input[name="terminal-preview-mode"]'),
    });
    const radio = group.getByRole("radio", { name: mode === "compact" ? /Compact/ : /Large/ });
    // The input is intentionally transparent and pointer-inert; click its visible label.
    await radio.locator("..").click();
    await expect(radio).toBeChecked();
  }

  async setRange(label: string, value: number): Promise<void> {
    const range = this.root.getByRole("slider", { name: label, exact: true });
    await range.fill(String(value));
  }

  async setHoverDelay(milliseconds: number): Promise<void> {
    await this.setRange("Hover delay", milliseconds);
  }

  async setPreviewAnimationDuration(milliseconds: number): Promise<void> {
    await this.setRange("Open animation duration", milliseconds);
  }

  async resetPreviewControls(): Promise<void> {
    await this.root.getByRole("button", { name: "Reset preview controls", exact: true }).click();
  }

  async setCachedTerminalLimit(limit: number): Promise<void> {
    await this.setRange("Terminals kept alive off screen", limit);
  }

  async setTerminalScrollback(lines: number): Promise<void> {
    await this.root.getByRole("spinbutton", { name: "Terminal scrollback lines", exact: true }).fill(String(lines));
  }

  async useServerScrollbackDefault(): Promise<void> {
    const setting = this.root.getByRole("group", { name: "Terminal scrollback", exact: true });
    await setting.getByRole("button", { name: /^Use the server default/ }).click();
  }

  async useServerCacheDefault(): Promise<void> {
    const setting = this.root.getByRole("group", { name: "Kept-alive terminals", exact: true });
    await setting.getByRole("button", { name: /^Use the server default/ }).click();
  }

  async chooseNotificationMode(mode: "In-app" | "System" | "Both" | "Off"): Promise<void> {
    const group = this.root.getByRole("radiogroup", { name: "Completion notification delivery", exact: true });
    await group.getByRole("radio", { name: mode, exact: true }).check();
  }

  async chooseNotificationPosition(position: "Top left" | "Top right" | "Bottom left" | "Bottom right"): Promise<void> {
    const group = this.root.getByRole("group", { name: "In-app position", exact: true });
    await group.getByRole("radio", { name: position, exact: true }).check();
  }

  async chooseNotificationDuration(duration: "4 sec" | "7 sec" | "12 sec" | "Keep open"): Promise<void> {
    const group = this.root.getByRole("group", { name: "Auto-dismiss", exact: true });
    await group.getByRole("radio", { name: duration, exact: true }).check();
  }

  async startRecording(): Promise<void> {
    await this.root.getByRole("button", { name: "Start recording", exact: true }).click();
  }

  async stopRecording(): Promise<void> {
    await this.root.getByRole("button", { name: "Stop recording", exact: true }).click();
  }

  async downloadRecording(): Promise<void> {
    await this.root.getByRole("button", { name: "Download recording", exact: true }).click();
  }

  async clearRecording(): Promise<void> {
    await this.root.getByRole("button", { name: "Discard", exact: true }).click();
  }

  async checkForUpdates(): Promise<void> {
    await this.root.getByRole("button", { name: /Check for updates/ }).click();
  }

  async restartBrokers(): Promise<void> {
    await this.root.getByRole("button", { name: "Restart all session brokers", exact: true }).click();
  }

  async openChangePassword(): Promise<void> {
    await this.root.getByRole("button", { name: "Change password", exact: true }).click();
  }

  async changePassword(current: string, next: string): Promise<void> {
    await this.openChangePassword();
    await this.root.getByLabel("Current password", { exact: true }).fill(current);
    await this.root.getByLabel("New password", { exact: true }).fill(next);
    await this.root.getByLabel("Confirm new password", { exact: true }).fill(next);
    await this.root.getByRole("button", { name: "Change password", exact: true }).click();
  }

  async signOut(): Promise<void> {
    await this.root.getByRole("button", { name: "Sign out", exact: true }).click();
  }
}

export default SettingsPage;
