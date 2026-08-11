import { expect, type Locator, type Page } from "@playwright/test";
import { SettingsPage } from "./settings-page.js";
import { SidebarPage, type TerminalReference } from "./sidebar-page.js";
import { TerminalPanePage } from "./terminal-pane.js";

/** The authenticated workspace and its high-level layout interactions. */
export class WorkbenchPage {
  readonly page: Page;
  readonly sidebar: SidebarPage;
  readonly settings: SettingsPage;

  constructor(page: Page) {
    this.page = page;
    this.sidebar = new SidebarPage(page);
    this.settings = new SettingsPage(page);
  }

  get root(): Locator {
    return this.page.locator(".workbench");
  }

  get workspaceArea(): Locator {
    return this.root.locator(".workspace-area");
  }

  get editorGrid(): Locator {
    return this.root.locator(".editor-grid");
  }

  get statusbar(): Locator {
    return this.root.locator("footer.statusbar");
  }

  async expectVisible(): Promise<void> {
    await expect(this.root).toBeVisible();
    await this.sidebar.expectVisible();
    await expect(this.statusbar).toBeAttached();
  }

  async createTerminal(): Promise<void> {
    const welcomeButton = this.root.getByRole("button", { name: "New terminal", exact: true });
    if (await welcomeButton.isVisible()) await welcomeButton.click();
    else await this.sidebar.createTerminal();
  }

  async openTerminal(reference: TerminalReference): Promise<TerminalPanePage> {
    return this.sidebar.openTerminal(reference);
  }

  async splitTerminal(reference: TerminalReference): Promise<TerminalPanePage> {
    return this.sidebar.splitTerminal(reference);
  }

  terminal(terminalId: string, name?: string): TerminalPanePage {
    return new TerminalPanePage(this.page, terminalId, name);
  }

  async openSettings(): Promise<SettingsPage> {
    await this.sidebar.openSettings();
    await this.settings.expectVisible();
    return this.settings;
  }

  async closeSettings(): Promise<void> {
    const close = this.root.getByRole("button", { name: "Close Settings", exact: true });
    if (await close.isVisible()) {
      await close.click();
    } else {
      const terminals = this.root.getByRole("button", { name: "Terminals", exact: true });
      if (await terminals.isVisible()) await terminals.click();
    }
    await this.settings.expectHidden();
  }

  async showTerminals(): Promise<void> {
    const terminals = this.root.getByRole("button", { name: "Terminals", exact: true });
    if (await terminals.isVisible()) await terminals.click();
    await this.settings.expectHidden();
  }

  async openMobileSidebar(): Promise<void> {
    await this.sidebar.openMobile();
  }

  async closeMobileSidebar(): Promise<void> {
    await this.sidebar.closeMobile();
  }

  async previousPane(): Promise<void> {
    await this.root.getByRole("button", { name: "Previous terminal pane", exact: true }).click();
  }

  async nextPane(): Promise<void> {
    await this.root.getByRole("button", { name: "Next terminal pane", exact: true }).click();
  }

  async visiblePaneCount(): Promise<number> {
    return this.editorGrid.locator(".pane-slot:not(.cached)").count();
  }

  async mountedPaneCount(): Promise<number> {
    return this.editorGrid.locator(".pane-slot").count();
  }

  async cachedPane(terminalId: string): Promise<Locator> {
    const escapedId = terminalId.replace(/["\\]/g, "\\$&");
    const pane = this.editorGrid.locator(
      `.pane-slot.cached [data-terminal-id="${escapedId}"], .pane-slot.cached [data-pane-id="pane-${escapedId}"]`,
    ).first();
    await expect(pane).toHaveCount(1);
    return pane;
  }

  async expectCached(terminalId: string): Promise<void> {
    const escapedId = terminalId.replace(/(["\\])/g, "\\$1");
    await expect(
      this.editorGrid.locator(`.pane-slot.cached[data-terminal-id="${escapedId}"]`),
    ).toHaveCount(1);
  }

  async expectVisibleTerminal(terminalId: string): Promise<void> {
    const escapedId = terminalId.replace(/(["\\])/g, "\\$1");
    await expect(
      this.editorGrid.locator(`.pane-slot:not(.cached)[data-terminal-id="${escapedId}"]`),
    ).toHaveCount(1);
  }

  async paneInstanceId(terminalId: string): Promise<string | null> {
    return this.editorGrid.locator(`[data-terminal-id="${terminalId.replace(/["\\]/g, "\\$&")}"]`).first().getAttribute("data-pane-id");
  }

  async terminalPaneIds(): Promise<string[]> {
    return this.editorGrid.locator("[data-terminal-id]").evaluateAll((elements) => (
      [...new Set(elements.map((element) => element.getAttribute("data-terminal-id")).filter((id): id is string => Boolean(id)))]
    ));
  }

  async dragTerminalToSplit(reference: TerminalReference, targetTerminalId: string, position: "left" | "top" | "center" | "bottom" | "right"): Promise<void> {
    const row = await this.sidebar.terminalRow(reference);
    const source = row.getByRole("button").first();
    const escapedTargetId = targetTerminalId.replace(/["\\]/g, "\\$&");
    const target = this.editorGrid.locator(`.pane-slot:not(.cached)[data-terminal-id="${escapedTargetId}"]`).first();
    const zones = this.editorGrid.locator(`.pane-drop-zone.${position}`);

    await expect(source).toBeVisible();
    const sourceBox = await source.boundingBox();
    expect(sourceBox, "terminal row drag button has no measurable geometry").not.toBeNull();
    if (!sourceBox || sourceBox.width <= 0 || sourceBox.height <= 0) {
      throw new Error("terminal row drag button has no measurable geometry");
    }

    await expect(target).toBeVisible();
    const targetBox = await target.boundingBox();
    expect(targetBox, "target terminal pane has no measurable geometry").not.toBeNull();
    if (!targetBox || targetBox.width <= 0 || targetBox.height <= 0) {
      throw new Error("target terminal pane has no measurable geometry");
    }

    const targetIndex = await target.evaluate((element) => {
      const panes = Array.from(
        element.parentElement?.querySelectorAll(".pane-slot:not(.cached)") ?? [],
      );
      return panes.indexOf(element);
    });
    if (targetIndex < 0) throw new Error(`Target terminal ${targetTerminalId} is not a visible pane`);
    const zone = zones.nth(targetIndex);

    const sourceX = sourceBox.x + sourceBox.width / 2;
    const sourceY = sourceBox.y + sourceBox.height / 2;
    const targetX = targetBox.x + targetBox.width / 2;
    const targetY = targetBox.y + targetBox.height / 2;

    await this.page.mouse.move(sourceX, sourceY);
    await this.page.mouse.down();
    try {
      await this.page.mouse.move(sourceX + 6, sourceY + 4, { steps: 2 });
      await this.page.mouse.move(targetX, targetY, { steps: 8 });
      await expect(zone).toBeVisible();

      const zoneBox = await zone.boundingBox();
      expect(zoneBox, `drop zone ${position} has no measurable geometry`).not.toBeNull();
      if (!zoneBox || zoneBox.width <= 0 || zoneBox.height <= 0) {
        throw new Error(`drop zone ${position} has no measurable geometry`);
      }
      await this.page.mouse.move(
        zoneBox.x + zoneBox.width / 2,
        zoneBox.y + zoneBox.height / 2,
        { steps: 3 },
      );
    } finally {
      await this.page.mouse.up();
    }
  }

  async statusText(): Promise<string> {
    return (await this.statusbar.innerText()).trim();
  }

  async expectConnectedStatus(): Promise<void> {
    await expect(this.statusbar.getByText("Connected", { exact: true })).toBeVisible();
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.page.setViewportSize({ width, height });
  }

  async closePane(terminalId: string, name?: string): Promise<void> {
    await this.terminal(terminalId, name).closePane();
  }
}

export { SettingsPage, SidebarPage, TerminalPanePage };
export default WorkbenchPage;
