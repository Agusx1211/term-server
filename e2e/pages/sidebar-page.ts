import { expect, type Locator, type Page } from "@playwright/test";
import { TerminalPanePage } from "./terminal-pane.js";

const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type TerminalReference = string | { id: string; name?: string };

/** Semantic controls for the workspace tree and its responsive sidebar. */
export class SidebarPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  get root(): Locator {
    return this.page.locator("aside.sidebar");
  }

  get tree(): Locator {
    return this.root.getByRole("tree");
  }

  get filter(): Locator {
    return this.root.getByRole("textbox", { name: "Filter workspaces", exact: true });
  }

  private async referenceName(reference: TerminalReference): Promise<string | undefined> {
    if (typeof reference === "string") return reference;
    if (reference.name) return reference.name;
    const escapedId = reference.id.replace(/["\\]/g, "\\$&");
    const pane = this.page.locator(`section[role="region"][data-terminal-id="${escapedId}"]`).first();
    const label = await pane.getAttribute("aria-label");
    return label?.replace(/^Terminal(?: pane)?\s+/, "").trim() || undefined;
  }

  async expectVisible(): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(this.tree).toBeVisible();
  }

  async terminalRow(reference: TerminalReference): Promise<Locator> {
    if (typeof reference !== "string") {
      const escapedId = reference.id.replace(/["\\]/g, "\\$&");
      const identified = this.root.locator(`.terminal-row[data-terminal-id="${escapedId}"]`);
      await expect(identified).toHaveCount(1);
      return identified;
    }

    const row = this.root.locator(".terminal-row").filter({
      has: this.page.locator(".terminal-title").filter({
        hasText: new RegExp(`^${regexEscape(reference)}$`),
      }),
    });
    await expect(row).toHaveCount(1);
    return row;
  }

  async openTerminal(reference: TerminalReference): Promise<TerminalPanePage> {
    const row = await this.terminalRow(reference);
    const main = row.getByRole("button").first();
    if (typeof reference === "string") {
      const terminalId = await row.getAttribute("data-terminal-id");
      if (!terminalId) throw new Error(`terminal row "${reference}" has no stable terminal id`);
      await main.click();
      return new TerminalPanePage(this.page, { terminalId, name: reference });
    }
    await main.click();
    return new TerminalPanePage(this.page, { terminalId: reference.id, name: reference.name });
  }

  async splitTerminal(reference: TerminalReference): Promise<TerminalPanePage> {
    const name = await this.referenceName(reference);
    if (!name) throw new Error("Splitting a terminal requires an accessible terminal name");
    const row = await this.terminalRow(reference);
    const terminalId = typeof reference === "string"
      ? await row.getAttribute("data-terminal-id")
      : reference.id;
    if (!terminalId) throw new Error(`terminal row "${name}" has no stable terminal id`);
    await row.hover();
    await row.getByRole("button", {
      name: `Open ${name} in split`,
      exact: true,
    }).click();
    if (typeof reference === "string") {
      return new TerminalPanePage(this.page, { terminalId, name });
    }
    return new TerminalPanePage(this.page, { terminalId: reference.id, name: reference.name });
  }

  async renameTerminal(reference: TerminalReference, newName: string): Promise<void> {
    const name = await this.referenceName(reference);
    if (!name) throw new Error("Renaming a terminal requires an accessible terminal name");
    const row = await this.terminalRow(reference);
    await row.hover();
    this.page.once("dialog", async (dialog) => {
      if (dialog.type() !== "prompt") {
        await dialog.dismiss();
        return;
      }
      await dialog.accept(newName);
    });
    await row.getByRole("button", { name: `Rename ${name}`, exact: true }).click();
  }

  async removeTerminal(reference: TerminalReference, confirm = true): Promise<void> {
    const name = await this.referenceName(reference);
    if (!name) throw new Error("Removing a terminal requires an accessible terminal name");
    const row = await this.terminalRow(reference);
    await row.hover();
    this.page.once("dialog", async (dialog) => {
      if (dialog.type() === "confirm") await dialog[confirm ? "accept" : "dismiss"]();
      else await dialog.dismiss();
    });
    await row.getByRole("button", { name: `Kill ${name}`, exact: true }).click();
  }
  async createTerminal(): Promise<void> {
    await this.root.getByRole("button", { name: "New terminal in home", exact: true }).click();
  }

  async createTerminalInWorkspace(path: string): Promise<void> {
    await this.root.getByRole("button", { name: `New terminal in ${path}`, exact: true }).click();
  }

  async openSettings(): Promise<void> {
    await this.root.getByRole("button", { name: "Settings", exact: true }).click();
  }

  async openFileExplorer(): Promise<void> {
    await this.root.getByRole("button", { name: "Open file explorer", exact: true }).click();
    await expect(this.root.getByRole("button", { name: "Show terminal workspaces", exact: true })).toBeVisible();
  }

  async showTerminalWorkspaces(): Promise<void> {
    await this.root.getByRole("button", { name: "Show terminal workspaces", exact: true }).click();
  }

  async filterWorkspaces(query: string): Promise<void> {
    await this.filter.fill(query);
  }

  async clearFilter(): Promise<void> {
    const clear = this.root.getByRole("button", { name: "Clear filter", exact: true });
    if (await clear.count()) await clear.click();
    else await this.filter.fill("");
  }

  async collapseAll(): Promise<void> {
    await this.root.getByRole("button", { name: "Collapse all", exact: true }).click();
  }

  async openPreview(reference: TerminalReference): Promise<Locator> {
    const name = await this.referenceName(reference);
    if (!name) throw new Error("Opening a preview requires an accessible terminal name");
    const row = await this.terminalRow(reference);
    await row.hover();
    const preview = this.page.getByRole("tooltip", { name: `Live preview of ${name}`, exact: true });
    await expect(preview).toBeVisible();
    return preview;
  }

  async closePreview(): Promise<void> {
    await this.root.locator(".sidebar-footer").hover();
    const previews = this.page.getByRole("tooltip", { name: /^Live preview of / });
    if (await previews.count()) await expect(previews).toBeHidden();
  }

  async openMobile(): Promise<void> {
    await this.page.getByRole("button", { name: "Open workspaces", exact: true }).click();
    await expect(this.page.getByRole("dialog", { name: "Workspaces and files", exact: true })).toBeVisible();
  }

  async closeMobile(): Promise<void> {
    const dialog = this.page.getByRole("dialog", { name: "Workspaces and files", exact: true });
    const close = dialog.getByRole("button", { name: "Close sidebar", exact: true });
    if (await close.count()) await close.click();
    else await this.page.getByRole("button", { name: "Close sidebar", exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  async resizeWithKeyboard(direction: "left" | "right" | "min" | "max", shift = false): Promise<void> {
    const separator = this.root.getByRole("separator", { name: "Resize workspace sidebar", exact: true });
    await separator.focus();
    const key = direction === "min" ? "Home" : direction === "max" ? "End" : direction === "left" ? "ArrowLeft" : "ArrowRight";
    await this.page.keyboard.press(shift && key.startsWith("Arrow") ? `Shift+${key}` : key);
  }

  async sidebarWidth(): Promise<number> {
    const value = await this.root.getByRole("separator", { name: "Resize workspace sidebar", exact: true }).getAttribute("aria-valuenow");
    if (value === null) throw new Error("Sidebar resize separator has no current value");
    return Number(value);
  }
}

export default SidebarPage;
