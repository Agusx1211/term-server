import { expect, type Locator, type Page } from "@playwright/test";
import type {
  E2ETerminalDiagnosticsApi,
  E2ETerminalEvent,
  E2ETerminalSnapshot,
  E2EWaitOptions,
} from "../../src/client/lib/e2e-diagnostics.js";

export interface TerminalPaneIdentity {
  /** Stable server terminal/session ID. */
  terminalId: string;
  /** Optional accessible name used to disambiguate duplicate terminal titles. */
  name?: string;
}

export interface TerminalWaitOptions extends E2EWaitOptions {
  terminalId?: string;
}

type E2EWindow = Window & {
  __TERM_SERVER_E2E__?: E2ETerminalDiagnosticsApi;
};

const cssAttribute = (value: string): string => value.replace(/(["\\])/g, "\\$1");
const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A small semantic facade for one terminal pane. The stable terminal ID is the
 * identity; pane instance IDs intentionally are not cached because cached-pane
 * eviction can recreate the renderer.
 */
export class TerminalPanePage {
  readonly page: Page;
  readonly identity: TerminalPaneIdentity;

  constructor(page: Page, terminalId: string, name?: string);
  constructor(page: Page, identity: TerminalPaneIdentity);
  constructor(page: Page, terminalIdOrIdentity: string | TerminalPaneIdentity, name?: string) {
    this.page = page;
    this.identity = typeof terminalIdOrIdentity === "string"
      ? { terminalId: terminalIdOrIdentity, name }
      : terminalIdOrIdentity;
  }

  get terminalId(): string {
    return this.identity.terminalId;
  }

  /**
   * Prefer the accessible region identity. The attribute selector is a narrow
   * fallback for panes whose accessible name has not rendered yet.
   */
  get root(): Locator {
    const id = cssAttribute(this.terminalId);
    const region = this.page.getByRole("region", {
      name: this.identity.name
        ? new RegExp(`^Terminal(?: pane)? ${regexEscape(this.identity.name)}$`)
        : /^Terminal(?: pane)? .+$/,
    });
    const identifiedRegion = region.filter({
      has: this.page.locator(`[data-terminal-id="${id}"]`),
    });
    return identifiedRegion.or(
      this.page.locator(`section[role="region"][data-terminal-id="${id}"]`),
    ).first();
  }

  get xtermHost(): Locator {
    return this.root.locator(".xterm-host");
  }

  get canvas(): Locator {
    return this.xtermHost.locator("canvas").first();
  }

  get connectionIndicator(): Locator {
    return this.root.locator(".connection");
  }

  async expectVisible(): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(this.xtermHost).toBeVisible();
  }

  async expectHidden(): Promise<void> {
    await expect(this.root).toBeHidden();
  }

  async expectConnected(): Promise<void> {
    await expect(this.connectionIndicator).toHaveAttribute("title", "connected");
  }

  async expectConnection(state: string): Promise<void> {
    await expect(this.connectionIndicator).toHaveAttribute("title", state);
  }

  async focus(): Promise<void> {
    await this.expectVisible();
    await this.xtermHost.click();
  }

  async type(text: string): Promise<void> {
    await this.focus();
    await this.page.keyboard.type(text);
  }

  async insertText(text: string): Promise<void> {
    await this.focus();
    await this.page.keyboard.insertText(text);
  }

  async press(key: string): Promise<void> {
    await this.focus();
    await this.page.keyboard.press(key);
  }

  async sendInput(text: string, submit = false): Promise<void> {
    await this.type(text);
    if (submit) await this.page.keyboard.press("Enter");
  }

  async openActions(): Promise<void> {
    const actions = this.root.getByRole("button", { name: "Terminal actions", exact: true });
    await actions.click();
    await expect(this.root.getByRole("menu")).toBeVisible();
  }

  async closeActions(): Promise<void> {
    const actions = this.root.getByRole("button", { name: "Terminal actions", exact: true });
    if (await actions.getAttribute("aria-expanded") === "true") await actions.click();
  }

  async openSearch(): Promise<void> {
    const desktopSearch = this.root.getByRole("button", { name: "Search scrollback", exact: true });
    if (await desktopSearch.isVisible()) {
      await desktopSearch.click();
    } else {
      const actions = this.root.getByRole("button", { name: "Terminal actions", exact: true });
      if (await actions.isVisible()) {
        await this.openActions();
        await this.root.getByRole("menuitem", { name: "Search scrollback", exact: true }).click();
      } else {
        await this.focus();
        const modifier = process.platform === "darwin" ? "Meta" : "Control";
        await this.page.keyboard.press(`${modifier}+f`);
      }
    }
    await expect(this.root.getByRole("search")).toBeVisible();
  }

  async searchScrollback(query: string): Promise<void> {
    await this.openSearch();
    const input = this.root.getByRole("searchbox", { name: "Search terminal scrollback", exact: true });
    await input.fill(query);
  }

  async closeSearch(): Promise<void> {
    const close = this.root.getByRole("button", { name: "Close terminal search", exact: true });
    if (await close.count()) await close.click();
  }

  async zoomIn(): Promise<void> {
    await this.root.getByRole("button", { name: /Zoom terminal in\./ }).click();
  }

  async zoomOut(): Promise<void> {
    await this.root.getByRole("button", { name: /Zoom terminal out\./ }).click();
  }

  async resetZoom(): Promise<void> {
    await this.root.getByRole("button", { name: /Reset terminal zoom/ }).click();
  }

  async focusSize(): Promise<void> {
    const button = this.root.getByRole("button", {
      name: /Focus this terminal at this device's size|Use this device's size instead|Return to the smallest connected terminal size/,
      exact: true,
    });
    if (await button.isVisible()) {
      await button.click();
      return;
    }
    await this.openActions();
    await this.root.getByRole("menuitem", { name: /Focus terminal size here|Use smallest terminal size/ }).click();
  }

  async openProcesses(): Promise<void> {
    const button = this.root.getByRole("button", { name: "Inspect terminal processes", exact: true });
    if (await button.count()) {
      await button.click();
    } else {
      await this.openActions();
      await this.root.getByRole("menuitem", { name: "Inspect processes", exact: true }).click();
    }
    await expect(this.page.getByRole("complementary", { name: "Terminal process inspector" })).toBeVisible();
  }

  async openArtifacts(): Promise<void> {
    const button = this.root.getByRole("button", { name: /^Open \d+ session artifact/ });
    await button.click();
  }

  async closePane(): Promise<void> {
    const button = this.root.getByRole("button", { name: "Close pane", exact: true });
    if (await button.count()) {
      await button.click();
    } else {
      await this.openActions();
      await this.root.getByRole("menuitem", { name: "Close pane", exact: true }).click();
    }
  }

  async clone(): Promise<void> {
    const button = this.root.getByRole("button", { name: "Clone terminal", exact: true });
    if (await button.count()) {
      await button.click();
    } else {
      await this.openActions();
      await this.root.getByRole("menuitem", { name: "Clone terminal", exact: true }).click();
    }
  }

  async kill(): Promise<void> {
    const button = this.root.getByRole("button", { name: "Kill terminal", exact: true });
    if (await button.count()) {
      await button.click();
    } else {
      await this.openActions();
      await this.root.getByRole("menuitem", { name: "Kill terminal", exact: true }).click();
    }
  }

  async waitForSnapshot(options: TerminalWaitOptions = {}): Promise<E2ETerminalSnapshot> {
    const terminalId = options.terminalId ?? this.terminalId;
    return this.page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, undefined, { timeout });
    }, { id: terminalId, timeout: options.timeout });
  }

  async snapshot(): Promise<E2ETerminalSnapshot | undefined> {
    return this.page.evaluate((id) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.terminal(id);
    }, this.terminalId);
  }

  async events(): Promise<readonly E2ETerminalEvent[]> {
    return this.page.evaluate((id) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.events(id);
    }, this.terminalId);
  }

  async waitForEvent(
    event: E2ETerminalEvent["type"],
    options: E2EWaitOptions = {},
  ): Promise<E2ETerminalEvent> {
    return this.page.evaluate(async ({ id, event, timeout, afterId }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForEvent(id, event, { timeout, afterId });
    }, { id: this.terminalId, event, timeout: options.timeout, afterId: options.afterId });
  }

  async waitForConnected(options: E2EWaitOptions = {}): Promise<E2ETerminalSnapshot> {
    return this.page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, { socketState: "connected" }, { timeout });
    }, { id: this.terminalId, timeout: options.timeout });
  }

  async waitForSynchronized(options: E2EWaitOptions = {}): Promise<E2ETerminalSnapshot> {
    const snapshot = await this.page.evaluate(async ({ id, timeout }) => {
      const api = (window as E2EWindow).__TERM_SERVER_E2E__;
      if (!api) throw new Error("term-server E2E diagnostics are unavailable");
      return api.waitForTerminal(id, {
        socketState: "connected",
        activeSocketCount: 1,
        acceptingInput: true,
      }, { timeout });
    }, { id: this.terminalId, timeout: options.timeout });
    return snapshot;
  }
}

export { TerminalPanePage as TerminalPane };
export default TerminalPanePage;
