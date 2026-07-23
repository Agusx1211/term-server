import {
  Bell,
  BellOff,
  BellRing,
  Download,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  Moon,
  Settings,
  Shield,
  Sparkles,
  SplitSquareHorizontal,
  Sun,
  RefreshCw,
  Trash2,
} from "lucide-preact";
import type {
  BuildInfo,
  PiConfig,
  UpdateConfig,
  UpdateStatus,
} from "../../shared/types";
import type { NotificationMode } from "../lib/notifications";
import { ChangePassword } from "./ChangePassword";
import type { ThemeName } from "./TerminalPane";

interface SettingsWorkspaceProps {
  active: boolean;
  theme: ThemeName;
  pi: PiConfig;
  build: BuildInfo;
  updateConfig: UpdateConfig;
  updateStatus: UpdateStatus | null;
  checkingForUpdate: boolean;
  installingUpdate: boolean;
  passwordManagedExternally: boolean;
  notificationMode: NotificationMode;
  tileNewTerminals: boolean;
  confirmTerminalKills: boolean;
  onTheme: (theme: ThemeName) => void;
  onPiChange: (titlesEnabled: boolean, summariesEnabled: boolean, model: string) => void;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
  onNotificationModeChange: (mode: NotificationMode) => void;
  onTileNewTerminalsChange: (enabled: boolean) => void;
  onConfirmTerminalKillsChange: (enabled: boolean) => void;
  onPasswordChanged: () => void;
  onLogout: () => void;
}

const notificationModes: Array<{
  mode: NotificationMode;
  label: string;
  description: string;
  Icon: typeof Bell;
}> = [
  {
    mode: "in-app",
    label: "In-app",
    description: "Show a completion card inside term-server.",
    Icon: MessageSquareText,
  },
  {
    mode: "system",
    label: "System",
    description: "Use desktop notifications, falling back in-app on delivery errors.",
    Icon: Bell,
  },
  {
    mode: "both",
    label: "Both",
    description: "Always show in-app and also attempt a desktop notification.",
    Icon: BellRing,
  },
  {
    mode: "off",
    label: "Off",
    description: "Keep only the unread bell on the agent row.",
    Icon: BellOff,
  },
];

export function SettingsWorkspace({
  active,
  theme,
  pi,
  build,
  updateConfig,
  updateStatus,
  checkingForUpdate,
  installingUpdate,
  passwordManagedExternally,
  notificationMode,
  tileNewTerminals,
  confirmTerminalKills,
  onTheme,
  onPiChange,
  onCheckForUpdate,
  onInstallUpdate,
  onNotificationModeChange,
  onTileNewTerminalsChange,
  onConfirmTerminalKillsChange,
  onPasswordChanged,
  onLogout,
}: SettingsWorkspaceProps) {
  const systemPermission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;

  return (
    <section class={`settings-workspace ${active ? "visible" : ""}`} aria-hidden={!active}>
      <div class="settings-page">
        <header class="settings-page-header">
          <span class="settings-page-icon"><Settings size={24} /></span>
          <span>
            <h1>Settings</h1>
            <p>Configure this browser and the term-server workspace.</p>
          </span>
        </header>

        <div class="settings-grid">
          <section class="settings-card">
            <header><Sun size={16} /><h2>Appearance</h2></header>
            <p>Choose how the workspace is rendered in this browser.</p>
            <div class="theme-switch" role="group" aria-label="Color theme">
              <button class={theme === "dark" ? "active" : ""} onClick={() => onTheme("dark")}>
                <Moon size={14} /> Dark
              </button>
              <button class={theme === "light" ? "active" : ""} onClick={() => onTheme("light")}>
                <Sun size={14} /> Light
              </button>
            </div>
          </section>

          <section class="settings-card">
            <header><LayoutDashboard size={16} /><h2>Terminal behavior</h2></header>
            <p>Control terminal creation and destructive actions in this browser.</p>
            <label class={`settings-toggle ${tileNewTerminals ? "active" : ""}`}>
              <SplitSquareHorizontal size={14} />
              <span>Tile new terminals</span>
              <input
                type="checkbox"
                checked={tileNewTerminals}
                onChange={(event) => onTileNewTerminalsChange(event.currentTarget.checked)}
              />
            </label>
            <p class="settings-hint">When off, a new terminal replaces the active pane.</p>
            <label class={`settings-toggle ${confirmTerminalKills ? "active" : ""}`}>
              <Trash2 size={14} />
              <span>Confirm before killing terminals</span>
              <input
                type="checkbox"
                checked={confirmTerminalKills}
                onChange={(event) => onConfirmTerminalKillsChange(event.currentTarget.checked)}
              />
            </label>
            <p class="settings-hint">Turn this off to make every terminal kill action immediate.</p>
          </section>

          <section class="settings-card settings-card-wide">
            <header><Bell size={16} /><h2>Completion notifications</h2></header>
            <p>Choose where agent completion alerts appear for this browser.</p>
            <div class="notification-mode-grid" role="radiogroup" aria-label="Completion notification delivery">
              {notificationModes.map(({ mode, label, description, Icon }) => (
                <label key={mode} class={`notification-mode ${notificationMode === mode ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="notification-mode"
                    value={mode}
                    checked={notificationMode === mode}
                    onChange={() => onNotificationModeChange(mode)}
                  />
                  <Icon size={17} />
                  <span>
                    <b>{label}</b>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </div>
            <p class="settings-hint">
              Desktop permission: <strong>{systemPermission}</strong>. In-app cards require the page to remain open.
            </p>
          </section>

          <section class="settings-card">
            <header><Sparkles size={16} /><h2>Agent metadata</h2></header>
            <p>Use Pi to generate concise labels from bounded terminal context.</p>
            <label class={`settings-toggle ${pi.titlesEnabled ? "active" : ""} ${pi.available ? "" : "disabled"}`}>
              <Sparkles size={14} />
              <span>Pi-generated titles</span>
              <input
                type="checkbox"
                checked={pi.titlesEnabled}
                disabled={!pi.available}
                onChange={(event) => onPiChange(
                  event.currentTarget.checked,
                  pi.summariesEnabled,
                  pi.model,
                )}
              />
            </label>
            <label class={`settings-toggle ${pi.summariesEnabled ? "active" : ""} ${pi.available ? "" : "disabled"}`}>
              <MessageSquareText size={14} />
              <span>Pi notification summaries</span>
              <input
                type="checkbox"
                checked={pi.summariesEnabled}
                disabled={!pi.available}
                onChange={(event) => onPiChange(
                  pi.titlesEnabled,
                  event.currentTarget.checked,
                  pi.model,
                )}
              />
            </label>
            {pi.available ? (
              <label class="pi-model-field">
                <span>Pi model</span>
                <select
                  value={pi.model}
                  disabled={!pi.titlesEnabled && !pi.summariesEnabled}
                  onChange={(event) => onPiChange(
                    pi.titlesEnabled,
                    pi.summariesEnabled,
                    event.currentTarget.value,
                  )}
                >
                  <option value="">Pi configured default</option>
                  {pi.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </label>
            ) : (
              <p class="settings-hint">Pi is unavailable. Install it for this user, then restart term-server.</p>
            )}
          </section>

          <section class="settings-card">
            <header><Download size={16} /><h2>Updates</h2></header>
            <p>Install releases authenticated by the embedded signing key.</p>
            <div class="settings-update">
              <div class="settings-update-version">
                <span>term-server v{build.version}</span>
                <code title={build.commit}>{build.commit.slice(0, 12)}</code>
              </div>
              {updateStatus?.state === "available" && updateStatus.latest ? (
                <>
                  <p class="settings-update-available">
                    v{updateStatus.latest.version} is available
                    <code title={updateStatus.latest.commit}>
                      {updateStatus.latest.commit.slice(0, 12)}
                    </code>
                  </p>
                  <button
                    class="settings-update-action primary"
                    onClick={onInstallUpdate}
                    disabled={installingUpdate}
                  >
                    {installingUpdate
                      ? <LoaderCircle class="spin" size={14} />
                      : <Download size={14} />}
                    {installingUpdate ? "Installing…" : "Install and reconnect"}
                  </button>
                </>
              ) : (
                <button
                  class="settings-update-action"
                  onClick={onCheckForUpdate}
                  disabled={!updateConfig.enabled || checkingForUpdate}
                >
                  <RefreshCw class={checkingForUpdate ? "spin" : ""} size={14} />
                  {checkingForUpdate
                    ? "Checking…"
                    : updateStatus?.state === "current"
                      ? "Up to date · Check again"
                      : "Check for updates"}
                </button>
              )}
              {!updateConfig.enabled && (
                <p class="settings-hint">{updateConfig.reason ?? "Automatic updates are unavailable."}</p>
              )}
              {updateConfig.enabled && (
                <p class="settings-hint">
                  Channel: {updateConfig.channel}. Running terminals stay active while the server reconnects.
                </p>
              )}
            </div>
          </section>

          <section class="settings-card">
            <header><Shield size={16} /><h2>Security</h2></header>
            <p>Manage access to this terminal server.</p>
            <ChangePassword
              managedExternally={passwordManagedExternally}
              onChanged={onPasswordChanged}
            />
            <button class="settings-logout" onClick={onLogout}><LogOut size={14} /> Sign out</button>
          </section>
        </div>
      </div>
    </section>
  );
}
